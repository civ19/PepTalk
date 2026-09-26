export class StorageService {
  async saveVideo(sessionId: string, _stream: unknown) {
    return `/data/videos/${sessionId}.webm`;
  }
}
