/**
 * Greenhouse application submission — supports both:
 *   1. Server-side form POST (old-style embed forms, no CAPTCHA)
 *   2. Headless Chrome via puppeteer-core (new React forms with reCAPTCHA)
 *
 * Browser mode connects to either:
 *   - Local @sparticuz/chromium (serverless Lambda/Netlify)
 *   - Remote Chrome via BROWSER_WS_ENDPOINT (e.g. Browserless, Render)
 */

const API_BASE = "https://boards-api.greenhouse.io/v1/boards";
const EMBED_BASE = "https://boards.greenhouse.io/embed";

/* ── Types ── */

export interface CandidateProfile {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  resumeText: string;
  resumePath?: string; // local file path for file upload
  authorizedToWork: boolean;
  requiresSponsorship: boolean;
  veteranStatus: boolean;
}

export interface ApplyResult {
  success: boolean;
  method: "form_post" | "browser";
  message: string;
  confirmationUrl?: string;
  answersSubmitted?: Record<string, string>;
}

interface GreenhouseQuestion {
  label: string;
  required: boolean;
  fields: Array<{
    name: string;
    type: string;
    values: Array<{ label: string; value: number | string }>;
  }>;
}

interface GreenhouseJobDetail {
  id: number;
  title: string;
  absolute_url: string;
  questions?: GreenhouseQuestion[];
}

/* ── API helpers ── */

export async function fetchJobWithQuestions(
  boardToken: string,
  jobId: string,
): Promise<GreenhouseJobDetail | null> {
  const url = `${API_BASE}/${boardToken}/jobs/${jobId}?questions=true`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as GreenhouseJobDetail;
  } catch {
    return null;
  }
}

async function fetchEmbedTokens(
  boardToken: string,
  jobId: string,
): Promise<{ fingerprint: string; renderDate: string; pageLoadTime: string } | null> {
  const url = `${EMBED_BASE}/job_app?for=${boardToken}&token=${jobId}`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const fp = html.match(/name="fingerprint"[^>]*value="([^"]+)"/);
    const rd = html.match(/name="render_date"[^>]*value="([^"]+)"/);
    const plt = html.match(/name="page_load_time"[^>]*value="([^"]+)"/);
    if (!fp || !rd || !plt) return null;
    return { fingerprint: fp[1], renderDate: rd[1], pageLoadTime: plt[1] };
  } catch {
    return null;
  }
}

async function parseEmbedQuestions(
  boardToken: string,
  jobId: string,
): Promise<Array<{ index: number; questionId: string; fieldType: "boolean" | "text" }>> {
  const url = `${EMBED_BASE}/job_app?for=${boardToken}&token=${jobId}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" },
      signal: AbortSignal.timeout(15_000),
    });
    const html = await res.text();
    const questions: Array<{ index: number; questionId: string; fieldType: "boolean" | "text" }> = [];
    const pattern = /job_application\[answers_attributes\]\[(\d+)\]\[question_id\]"[^>]*value="(\d+)"/g;
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const idx = parseInt(match[1], 10);
      const qid = match[2];
      const hasBool = html.includes(`answers_attributes][${idx}][boolean_value]`);
      questions.push({ index: idx, questionId: qid, fieldType: hasBool ? "boolean" : "text" });
    }
    return questions;
  } catch {
    return [];
  }
}

function mapAnswers(
  apiQuestions: GreenhouseQuestion[],
  embedQuestions: Array<{ index: number; questionId: string; fieldType: "boolean" | "text" }>,
  candidate: CandidateProfile,
): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const eq of embedQuestions) {
    const apiQ = apiQuestions.find((q) => q.fields[0]?.name.includes(eq.questionId));
    const prefix = `job_application[answers_attributes][${eq.index}]`;
    fields[`${prefix}[question_id]`] = eq.questionId;
    fields[`${prefix}[priority]`] = String(eq.index);

    const label = (apiQ?.label || "").toLowerCase();
    const valueKey = eq.fieldType === "boolean" ? `${prefix}[boolean_value]` : `${prefix}[text_value]`;

    if (label.includes("previously applied") || label.includes("have you ever worked")) {
      fields[valueKey] = "0";
    } else if (label.includes("authorized") || label.includes("legally")) {
      fields[valueKey] = candidate.authorizedToWork ? "1" : "0";
    } else if (label.includes("sponsorship") || label.includes("visa")) {
      fields[valueKey] = candidate.requiresSponsorship ? "1" : "0";
    } else if (label.includes("veteran") || label.includes("military")) {
      fields[valueKey] = candidate.veteranStatus ? "1" : "0";
    } else if (label.includes("privacy") || label.includes("consent")) {
      fields[valueKey] = "1";
    } else if (eq.fieldType === "boolean") {
      fields[valueKey] = "1";
    } else {
      fields[valueKey] = "N/A";
    }
  }
  return fields;
}

/* ── Method 1: Server-side form POST (old-style forms, no CAPTCHA) ── */

export async function applyViaFormPost(
  boardToken: string,
  jobId: string,
  candidate: CandidateProfile,
): Promise<ApplyResult> {
  const job = await fetchJobWithQuestions(boardToken, jobId);
  if (!job) return { success: false, method: "form_post", message: "Failed to fetch job details" };

  const tokens = await fetchEmbedTokens(boardToken, jobId);
  if (!tokens) {
    return { success: false, method: "form_post", message: "No embed tokens — form likely uses reCAPTCHA (needs browser mode)" };
  }

  const embedQuestions = await parseEmbedQuestions(boardToken, jobId);
  const params = new URLSearchParams();
  params.append("utf8", "✓");
  params.append("fingerprint", tokens.fingerprint);
  params.append("render_date", tokens.renderDate);
  params.append("page_load_time", tokens.pageLoadTime);
  params.append("from_embed", "true");
  params.append("security_code", "");
  params.append("job_application[first_name]", candidate.firstName);
  params.append("job_application[last_name]", candidate.lastName);
  params.append("job_application[email]", candidate.email);
  params.append("job_application[phone]", candidate.phone);
  params.append("job_application[resume_text]", candidate.resumeText);

  const answersSubmitted: Record<string, string> = {};
  if (job.questions && embedQuestions.length > 0) {
    const answerFields = mapAnswers(job.questions, embedQuestions, candidate);
    for (const [key, value] of Object.entries(answerFields)) {
      params.append(key, value);
      if (!key.includes("question_id") && !key.includes("priority")) {
        answersSubmitted[key] = value;
      }
    }
  }

  const submitUrl = `${EMBED_BASE}/${boardToken}/jobs/${jobId}`;
  const res = await fetch(submitUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0.0.0",
      Origin: "https://boards.greenhouse.io",
      Referer: `${EMBED_BASE}/job_app?for=${boardToken}&token=${jobId}`,
    },
    body: params.toString(),
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });

  const location = res.headers.get("location") || "";
  if (res.status === 302 || res.status === 301) {
    const isSuccess = location.includes("confirmation") || location.includes("thank");
    return {
      success: isSuccess,
      method: "form_post",
      message: isSuccess ? "Application submitted via form POST" : `Redirected to: ${location}`,
      confirmationUrl: location || undefined,
      answersSubmitted,
    };
  }

  const text = await res.text();
  const hasError = text.includes("error") || text.includes("required");
  return {
    success: !hasError && text.includes("thank"),
    method: "form_post",
    message: hasError ? `Form errors in response (HTTP ${res.status})` : `HTTP ${res.status}`,
    answersSubmitted,
  };
}

/* ── Method 2: Headless Chrome (handles reCAPTCHA) ── */

export async function applyViaBrowser(
  boardToken: string,
  jobId: string,
  candidate: CandidateProfile,
): Promise<ApplyResult> {
  const job = await fetchJobWithQuestions(boardToken, jobId);
  if (!job) return { success: false, method: "browser", message: "Failed to fetch job details" };

  let browser: any;
  try {
    const puppeteer = await import("puppeteer-core");
    const wsEndpoint = process.env.BROWSER_WS_ENDPOINT;

    if (wsEndpoint) {
      // Remote Chrome (Browserless, Render, etc.)
      browser = await puppeteer.default.connect({ browserWSEndpoint: wsEndpoint });
    } else {
      // Local @sparticuz/chromium (serverless)
      const chromium = await import("@sparticuz/chromium");
      browser = await puppeteer.default.launch({
        args: chromium.default.args,
        defaultViewport: { width: 1280, height: 720 },
        executablePath: await chromium.default.executablePath(),
        headless: true,
      });
    }

    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
    );

    const embedUrl = `${EMBED_BASE}/job_app?for=${boardToken}&token=${jobId}`;
    await page.goto(embedUrl, { waitUntil: "networkidle2", timeout: 30_000 });
    await page.waitForSelector("#application_form", { timeout: 10_000 });

    // Fill candidate fields
    await page.type("#first_name", candidate.firstName, { delay: 30 });
    await page.type("#last_name", candidate.lastName, { delay: 30 });
    await page.type("#email", candidate.email, { delay: 30 });
    const phoneField = await page.$("#phone");
    if (phoneField) await phoneField.type(candidate.phone, { delay: 30 });

    // Resume text
    const pasteLink = await page.$('a.paste-resume, a[data-action="paste"]');
    if (pasteLink) {
      await pasteLink.click();
      await new Promise((r) => setTimeout(r, 500));
    }
    const resumeArea = await page.$('textarea[name="job_application[resume_text]"]');
    if (resumeArea) await resumeArea.type(candidate.resumeText, { delay: 5 });

    // Resume file upload
    if (candidate.resumePath) {
      const fileInput = await page.$('input[type="file"][name*="resume"]');
      if (fileInput) await fileInput.uploadFile(candidate.resumePath);
    }

    // Answer custom questions
    if (job.questions) {
      for (let i = 0; i < job.questions.length; i++) {
        const q = job.questions[i];
        const field = q.fields[0];
        if (!field) continue;
        if (["first_name", "last_name", "email", "phone", "resume", "resume_text"].includes(field.name)) continue;

        const prefix = `job_application[answers_attributes][${i}]`;
        const label = q.label.toLowerCase();

        if (field.type === "multi_value_single_select") {
          const sel = await page.$(`select[name="${prefix}[boolean_value]"]`);
          if (sel) {
            let val = "1";
            if (label.includes("previously applied")) val = "0";
            else if (label.includes("sponsorship") || label.includes("visa")) val = candidate.requiresSponsorship ? "1" : "0";
            else if (label.includes("authorized")) val = candidate.authorizedToWork ? "1" : "0";
            else if (label.includes("veteran")) val = candidate.veteranStatus ? "1" : "0";
            await sel.select(val);
          }
        }
      }
    }

    // Wait for reCAPTCHA
    await new Promise((r) => setTimeout(r, 2000));

    // Submit
    const submitBtn = await page.$('#submit_app, button[type="submit"], input[type="submit"]');
    if (!submitBtn) throw new Error("Submit button not found");

    const [navResponse] = await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30_000 }).catch(() => null),
      submitBtn.click(),
    ]);

    const finalUrl = page.url();
    const bodyText = await page.evaluate(() => document.body.innerText);
    const isSuccess =
      finalUrl.includes("confirmation") ||
      bodyText.toLowerCase().includes("thank you") ||
      bodyText.toLowerCase().includes("application has been submitted");
    const hasError =
      bodyText.toLowerCase().includes("error") || bodyText.toLowerCase().includes("please fill");

    return {
      success: isSuccess && !hasError,
      method: "browser",
      message: isSuccess ? "Application submitted via browser" : `Submission unclear. URL: ${finalUrl}`,
      confirmationUrl: isSuccess ? finalUrl : undefined,
    };
  } catch (err) {
    return {
      success: false,
      method: "browser",
      message: `Browser apply failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    if (browser) {
      const wsEndpoint = process.env.BROWSER_WS_ENDPOINT;
      if (wsEndpoint) {
        browser.disconnect(); // Don't close shared remote browser
      } else {
        await browser.close();
      }
    }
  }
}

/**
 * Try form POST first (fast, no browser needed).
 * Fall back to browser mode if form has reCAPTCHA.
 */
export async function applyToJob(
  boardToken: string,
  jobId: string,
  candidate: CandidateProfile,
  mode?: "form_post" | "browser" | "auto",
): Promise<ApplyResult> {
  const effectiveMode = mode || "auto";

  if (effectiveMode === "form_post") {
    return applyViaFormPost(boardToken, jobId, candidate);
  }
  if (effectiveMode === "browser") {
    return applyViaBrowser(boardToken, jobId, candidate);
  }

  // Auto: try form POST, fall back to browser
  const formResult = await applyViaFormPost(boardToken, jobId, candidate);
  if (formResult.success) return formResult;
  if (formResult.message.includes("reCAPTCHA") || formResult.message.includes("needs browser")) {
    return applyViaBrowser(boardToken, jobId, candidate);
  }
  return formResult;
}
