import { createStorage } from "@appstrate/core/storage";
import { join } from "node:path";
import { getEnv } from "@appstrate/env";

const STORAGE_DIR = getEnv().STORAGE_DIR || join(process.cwd(), "data", "storage");

const store = createStorage(STORAGE_DIR);

export const { ensureBucket, uploadFile, downloadFile, deleteFile, listFiles } = store;
