import { createContext, useContext } from 'react';
import type { FileScope } from './workspace-file-links';
export const WorkspaceFileContext = createContext<FileScope[]>([]);
export const useWorkspaceFileScope = () => useContext(WorkspaceFileContext);
