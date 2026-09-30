import type { Config } from "../config.js";
import { LocalFileStorage } from "./local.js";
import type { MediaStorage } from "./provider.js";
import { SupabaseStorage } from "./supabase.js";

export type { MediaStorage, MediaKind, StoredMedia } from "./provider.js";
export { kindForMime, isAllowedMime } from "./provider.js";

export function createMediaStorage(config: Config): MediaStorage {
  if (config.MEDIA_STORAGE_PROVIDER === "supabase") {
    return new SupabaseStorage({
      baseUrl: config.SUPABASE_URL!,
      serviceRoleKey: config.SUPABASE_SERVICE_ROLE_KEY!,
      bucket: config.SUPABASE_MEDIA_BUCKET,
    });
  }
  return new LocalFileStorage();
}
