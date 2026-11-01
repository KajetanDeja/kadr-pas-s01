export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { config } = await import("./server/config");
    config();
  }
}
