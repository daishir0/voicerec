export type UploadStatus = 'waiting' | 'uploading' | 'uploaded' | 'failed';

export interface RecordingEntry {
  id: string;
  uri: string;
  filename: string;
  displayName: string;
  duration: number;
  fileSize: number;
  mimeType: string;
  uploadStatus: UploadStatus;
  serverId?: string;
  createdAt: string;
}

export interface ServerSettings {
  serverUrl: string;
  username: string;
  password: string;
  /** 初回ログイン後にサーバーが発行する Bearer token。以降の通信はこれを使用。 */
  token?: string | null;
}
