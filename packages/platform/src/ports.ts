/** Environment and filesystem access are injected so tests never touch the real host. */
export type Environment = Readonly<Record<string, string | undefined>>;

export type PathKind = 'file' | 'directory' | 'other' | 'missing';

export type TextFileSystem = {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(path: string, content: string, encoding: 'utf8'): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options: { force: true }): Promise<void>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ readonly mtimeMs: number; isFile(): boolean; isDirectory(): boolean }>;
};

export interface FileSystemPort {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  /** Atomic replace: write a sibling temp file, fsync, rename over the destination. */
  writeFileAtomic(path: string, content: string): Promise<void>;
  mkdirp(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Last-modification time in milliseconds; `undefined` when the path is missing. */
  modifiedAt(path: string): Promise<number | undefined>;
  kind(path: string): Promise<PathKind>;
  readdir(path: string): Promise<string[]>;
  /** True when the current user may write `path`; used to decide whether elevation is required. */
  canWrite(path: string): Promise<boolean>;
}
