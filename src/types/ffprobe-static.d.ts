declare module "ffprobe-static" {
  /** Absolute path to the bundled static ffprobe binary for this platform. */
  export const path: string;
  const ffprobe: { path: string };
  export default ffprobe;
}
