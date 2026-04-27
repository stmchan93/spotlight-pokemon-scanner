import type { PortfolioImportSelectedFile } from './portfolio-import-file';

let pendingPortfolioImportFile: PortfolioImportSelectedFile | null = null;

export function setPendingPortfolioImportFile(file: PortfolioImportSelectedFile | null) {
  pendingPortfolioImportFile = file;
}

export function peekPendingPortfolioImportFile() {
  return pendingPortfolioImportFile;
}

export function takePendingPortfolioImportFile() {
  const file = pendingPortfolioImportFile;
  pendingPortfolioImportFile = null;
  return file;
}
