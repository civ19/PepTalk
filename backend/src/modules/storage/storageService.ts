export class StorageService {
  async saveVideo(sessionId: string, stream: any) {
    return f"/data/videos/{sessionId}.webm";
  }
}
