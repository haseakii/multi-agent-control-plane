/** A read-only view of web files; remote workspace providers can implement the same port. */
export interface WorkspacePreviewFiles {
  list(): Promise<Array<{ path: string; size: number; modifiedAt: number }>>;
  read(path: string): Promise<{ content: Uint8Array; mimeType: string }>;
}
