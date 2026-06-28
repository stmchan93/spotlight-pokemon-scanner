import type { PortfolioImportSelectedFile } from './portfolio-import-file';

let pendingPortfolioImportFile: PortfolioImportSelectedFile | null = null;

export function setPendingPortfolioImportFile(file: PortfolioImportSelectedFile | null) {
  pendingPortfolioImportFile = file;
}

export function takePendingPortfolioImportFile() {
  const file = pendingPortfolioImportFile;
  pendingPortfolioImportFile = null;
  return file;
}
