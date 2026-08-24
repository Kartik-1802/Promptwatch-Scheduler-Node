import { redirect } from "next/navigation";

/** The actual dashboard is the same tested static HTML/CSS/JS from the Python
 * version, served as-is from /public and hitting the identical /api/* paths —
 * only the backend underneath changed. */
export default function Home() {
  redirect("/index.html");
}
