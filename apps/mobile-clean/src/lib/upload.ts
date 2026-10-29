/**
 * Picking a photo or document and uploading it to a private bucket.
 *
 * Paths follow the database's rules: condition and incident photos go to
 * <booking_id>/<user_id>/<file>, certificates to <user_id>/<file>. The database
 * refuses any other path, so a wrong path fails loudly instead of leaking.
 */
import * as ImagePicker from "expo-image-picker";
import { decode } from "base64-arraybuffer";
import { Platform } from "react-native";
import { supabase } from "./supabase";
import { AppError } from "./api";

export type Picked = { uri: string; base64?: string | null; mime: string; name: string; webFile?: File };

const id = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export async function pickPhoto(useCamera: boolean): Promise<Picked | null> {
  if (useCamera && Platform.OS !== "web") {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) throw new AppError("Camera permission is off. Allow it in Settings, or choose from your photos.");
  }
  const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 0.6, base64: Platform.OS !== "web", exif: false };
  const res = useCamera && Platform.OS !== "web" ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
  if (res.canceled || !res.assets?.[0]) return null;
  const a = res.assets[0];
  const mime = a.mimeType && /^image\/(jpeg|png|webp)$/.test(a.mimeType) ? a.mimeType : "image/jpeg";
  return { uri: a.uri, base64: a.base64, mime, name: `${id()}.${mime.split("/")[1].replace("jpeg", "jpg")}`, webFile: (a as any).file };
}

export async function upload(bucket: string, folder: string, file: Picked): Promise<string> {
  const path = `${folder}/${file.name}`;
  let body: ArrayBuffer | Blob;
  if (file.base64) body = decode(file.base64);
  else if (file.webFile) body = file.webFile;
  else body = await (await fetch(file.uri)).blob();
  const size = body instanceof Blob ? body.size : body.byteLength;
  if (size > 8 * 1024 * 1024) throw new AppError("That file is larger than 8 MB. Choose a smaller one.");
  const { error } = await supabase.storage.from(bucket).upload(path, body, { contentType: file.mime, upsert: false });
  if (error) throw new AppError(error.message.includes("row-level security") ? "You can't upload here." : error.message);
  return path;
}

export function publicUrl(bucket: string, path: string): string {
  return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}

export async function signedUrl(bucket: string, path: string): Promise<string | null> {
  const { data } = await supabase.storage.from(bucket).createSignedUrl(path, 3600);
  return data?.signedUrl ?? null;
}
