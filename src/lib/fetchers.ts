/* ── ATS Fetchers ── */

export interface RawJob {
  job_id: string;
  title: string;
  url: string;
  location: string;
  department: string;
}

export async function fetchGreenhouse(token: string): Promise<RawJob[]> {
  const res = await fetch(
    `https://boards-api.greenhouse.io/v1/boards/${token}/jobs`,
    { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) }
  );
  if (!res.ok) return [];
  const data = await res.json();
  return (data.jobs || []).map((j: any) => ({
    job_id: String(j.id),
    title: j.title,
    url: j.absolute_url,
    location: j.location?.name || "Unknown",
    department: j.departments?.[0]?.name || "General",
  }));
}

export async function fetchLever(token: string): Promise<RawJob[]> {
  const res = await fetch(
    `https://api.lever.co/v0/postings/${token}`,
    { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) }
  );
  if (!res.ok) return [];
  const data = await res.json();
  return (data || []).map((j: any) => ({
    job_id: j.id,
    title: j.text,
    url: j.hostedUrl,
    location: j.categories?.location || "Unknown",
    department: j.categories?.department || j.categories?.team || "General",
  }));
}

export async function fetchAshby(token: string): Promise<RawJob[]> {
  const res = await fetch(
    `https://api.ashbyhq.com/posting-api/job-board/${token}`,
    { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) }
  );
  if (!res.ok) return [];
  const data = await res.json();
  return (data.jobs || []).map((j: any) => ({
    job_id: j.id,
    title: j.title,
    url: j.jobUrl,
    location: j.location || "Unknown",
    department: j.department || j.team || "General",
  }));
}

const fetchers: Record<string, (token: string) => Promise<RawJob[]>> = {
  greenhouse: fetchGreenhouse,
  lever: fetchLever,
  ashby: fetchAshby,
};

export async function crawlBoard(token: string, ats: string): Promise<RawJob[]> {
  const fetcher = fetchers[ats];
  if (!fetcher) return [];
  return fetcher(token);
}
