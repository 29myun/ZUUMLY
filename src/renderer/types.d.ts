export {};

// Type the preload bridge injected by Electron at runtime.
declare global {
  interface Window {
    screenAssist: {
      listSources: () => Promise<
        {
          id: string;
          name: string;
          thumbnail: string;
        }[]
      >;
      openOverlay: () => void;
      minimizeWindow: () => Promise<void>;
      restoreWindow: () => Promise<void>;
      onScreenSelection: (callback: (rect: { x: number; y: number; width: number; height: number }) => void) => void;
      saveSnapshot: (dataUrl: string) => Promise<string>;
      readSnapshot: (filePath: string) => Promise<string | null>;
      deleteSnapshot: (filePath: string) => Promise<void>;
    };
  }
}
