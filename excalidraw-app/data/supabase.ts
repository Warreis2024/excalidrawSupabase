// supabase.ts - Supabase entegrasyonu, Firebase mantığıyla bire bir

import { reconcileElements } from "@excalidraw/excalidraw";
import { MIME_TYPES } from "@excalidraw/common";
import { decompressData } from "@excalidraw/excalidraw/data/encode";
import {
  encryptData,
  decryptData,
} from "@excalidraw/excalidraw/data/encryption";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { getSceneVersion } from "@excalidraw/element";
import { createClient } from "@supabase/supabase-js";

import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type {
  ExcalidrawElement,
  FileId,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFileMetadata,
  DataURL,
} from "@excalidraw/excalidraw/types";

import { FILE_CACHE_MAX_AGE_SEC } from "../app_constants";
import { getSyncableElements } from ".";
import type { SyncableExcalidrawElement } from ".";
import type Portal from "../collab/Portal";
import type { Socket } from "socket.io-client";

const SUPABASE_URL = import.meta.env.VITE_APP_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_APP_SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

class SupabaseSceneVersionCache {
  private static cache = new WeakMap<Socket, number>();
  static get = (socket: Socket) => SupabaseSceneVersionCache.cache.get(socket);
  static set = (
    socket: Socket,
    elements: readonly SyncableExcalidrawElement[],
  ) => {
    SupabaseSceneVersionCache.cache.set(socket, getSceneVersion(elements));
  };
}

const encryptElements = async (key: string, elements: readonly ExcalidrawElement[]) => {
  const json = JSON.stringify(elements);
  const encoded = new TextEncoder().encode(json);
  const { encryptedBuffer, iv } = await encryptData(key, encoded);
  return { ciphertext: encryptedBuffer, iv };
};

const decryptElements = async (data: any, roomKey: string): Promise<readonly ExcalidrawElement[]> => {
  const decrypted = await decryptData(data.iv, data.ciphertext, roomKey);
  const decoded = new TextDecoder().decode(new Uint8Array(decrypted));
  return JSON.parse(decoded);
};

export const isSavedToSupabase = (
  portal: Portal,
  elements: readonly ExcalidrawElement[],
): boolean => {
  if (portal.socket && portal.roomId && portal.roomKey) {
    return SupabaseSceneVersionCache.get(portal.socket) === getSceneVersion(elements);
  }
  return true;
};

export const saveToSupabase = async (
  portal: Portal,
  elements: readonly SyncableExcalidrawElement[],
  appState: AppState,
) => {
  const { roomId, roomKey, socket } = portal;
  if (!roomId || !roomKey || !socket || isSavedToSupabase(portal, elements)) return null;

  const { data: existing } = await supabase.from("scenes").select("*").eq("id", roomId).single();

  let reconciledElements = elements;

  if (existing) {
    const prev = await decryptElements(existing, roomKey);
    reconciledElements = getSyncableElements(
      reconcileElements(
        elements,
        getSyncableElements(restoreElements(prev, null)) as OrderedExcalidrawElement[] as RemoteExcalidrawElement[],
        appState,
      ),
    );
  }

  const { ciphertext, iv } = await encryptElements(roomKey, reconciledElements);

  await supabase.from("scenes").upsert({
    id: roomId,
    sceneVersion: getSceneVersion(reconciledElements),
    ciphertext,
    iv,
  });

  SupabaseSceneVersionCache.set(socket, reconciledElements);
  return reconciledElements;
};

export const loadFromSupabase = async (
  roomId: string,
  roomKey: string,
  socket: Socket | null,
): Promise<readonly SyncableExcalidrawElement[] | null> => {
  const { data } = await supabase.from("scenes").select("*").eq("id", roomId).single();
  if (!data) return null;

  const elements = getSyncableElements(
    restoreElements(await decryptElements(data, roomKey), null),
  );

  if (socket) SupabaseSceneVersionCache.set(socket, elements);

  return elements;
};

export const saveFilesToSupabase = async ({
  prefix,
  files,
}: {
  prefix: string;
  files: { id: FileId; buffer: Uint8Array }[];
}) => {
  const savedFiles: FileId[] = [];
  const erroredFiles: FileId[] = [];

  await Promise.all(
    files.map(async ({ id, buffer }) => {
      try {
        const { error } = await supabase.storage
          .from("files")
          .upload(`${prefix}/${id}`, new Blob([buffer]), {
            cacheControl: `public, max-age=${FILE_CACHE_MAX_AGE_SEC}`,
            upsert: true,
          });
        if (error) throw error;
        savedFiles.push(id);
      } catch (_) {
        erroredFiles.push(id);
      }
    })
  );

  return { savedFiles, erroredFiles };
};

export const loadFilesFromSupabase = async (
  prefix: string,
  decryptionKey: string,
  filesIds: readonly FileId[],
) => {
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  await Promise.all(
    [...new Set(filesIds)].map(async (id) => {
      try {
        const { data } = supabase.storage.from("files").getPublicUrl(`${prefix}/${id}`);
        const response = await fetch(data.publicUrl);
        if (response.status >= 400) throw new Error("File fetch failed");

        const buffer = await response.arrayBuffer();
        const { data: fileData, metadata } = await decompressData<BinaryFileMetadata>(
          new Uint8Array(buffer),
          { decryptionKey },
        );

        const dataURL = new TextDecoder().decode(fileData) as DataURL;

        loadedFiles.push({
          mimeType: metadata.mimeType || MIME_TYPES.binary,
          id,
          dataURL,
          created: metadata?.created || Date.now(),
          lastRetrieved: metadata?.created || Date.now(),
        });
      } catch (e) {
        erroredFiles.set(id, true);
        console.error(e);
      }
    })
  );

  return { loadedFiles, erroredFiles };
};
