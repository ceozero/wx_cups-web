export type JobStatus = 'received' | 'downloading' | 'validating' | 'submitting' | 'accepted' | 'rejected' | 'uncertain' | 'failed';

export interface StoredMessage {
  msgId: string;
  userId: string;
  status: JobStatus;
  result?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PrintableFile {
  filename: string;
  contentType: string;
  buffer: Buffer;
}

export interface IncomingMessage {
  msgId: string;
  userId: string;
  /** 延迟下载，确保去重成功后才拉取企业微信的媒体文件。 */
  loadFiles: () => Promise<PrintableFile[]>;
}

export interface PrintReceipt {
  jobId: string | number;
  pages?: number;
}

export interface ProcessingResult {
  status: JobStatus;
  reply: string;
}

export interface PrinterSubmitter {
  submit(file: PrintableFile): Promise<PrintReceipt>;
}
