/** Căn khung với thời gian (research R6): tính từ chỉ số khung, không cộng dồn nên không trôi. */
export const FPS = 30;
/** Một khung hình, làm tròn lên (ms). */
export const FRAME_MS = 34;

export const frameCount = (durationMs: number): number => Math.max(1, Math.round((durationMs * FPS) / 1000));
/** Thời điểm đại diện (giữa khung) của khung thứ k. */
export const frameTimeMs = (k: number): number => ((k + 0.5) * 1000) / FPS;
export const framesToMs = (frames: number): number => (frames * 1000) / FPS;
