# artifact-store

Immutable content-addressed artifact storage for V0.

The package separates blob storage from metadata storage:

- `ArtifactBlobStore` owns immutable bytes.
- `ArtifactMetadataStore` owns durable artifact metadata and entity links.
- `FilesystemArtifactBlobStore` stores blobs under `sha256/<prefix>/<digest>`.
- `SqliteArtifactMetadataStore` persists metadata through the shared storage package and durable `artifact_links`.

Publishing identical bytes creates only one blob while allowing separate metadata records to retain task, assignment, and producer provenance. Tasks and messages continue to reference artifacts by stable artifact IDs.

Blob reads verify the SHA-256 content address. No mutable overwrite API is exposed.
