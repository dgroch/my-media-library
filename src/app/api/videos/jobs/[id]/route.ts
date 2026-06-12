import { NextResponse } from "next/server";

import { checkAssetWriteAuth } from "@/lib/auth";
import { getJob } from "@/lib/videoJobs";

export const dynamic = "force-dynamic";

/** Poll a video frame-extraction job. Gated like the rest of the asset writes. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = checkAssetWriteAuth(request);
  if (denied) {
    return NextResponse.json({ error: denied.error }, { status: denied.status });
  }

  const { id } = await params;
  const job = getJob(id);
  if (!job) {
    return NextResponse.json(
      { error: "Job not found (it may have expired)." },
      { status: 404 },
    );
  }
  return NextResponse.json(job);
}
