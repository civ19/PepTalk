export class ElevenLabsService {
  async synthesizeSpeech(_text: string) {
    return Buffer.from("mock-audio-data");
  }
}
