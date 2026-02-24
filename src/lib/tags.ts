/**
 * Tag → keyword mappings. A job is tagged if its title+department
 * contains any keyword for that tag (case-insensitive).
 */
const TAG_KEYWORDS: Record<string, string[]> = {
  quant: [
    "quant", "quantitative", "trading", "risk", "alpha", "signal",
    "portfolio", "derivatives", "options", "futures", "hft",
    "low latency", "market making", "execution", "pricing",
    "stochastic", "statistical", "backtesting", "factor",
    "systematic", "algo", "algorithmic",
  ],
  ml: [
    "machine learning", "ml", "deep learning", "neural",
    "nlp", "natural language", "computer vision", "cv",
    "data scientist", "data science", "ai ",
  ],
  engineering: [
    "engineer", "developer", "software", "swe", "devops",
    "infrastructure", "platform", "backend", "back-end",
    "fullstack", "full-stack",
  ],
  frontend: [
    "frontend", "front-end", "react", "ui", "ux",
  ],
  research: [
    "research", "researcher",
  ],
  analyst: [
    "analyst", "analysis", "analytics",
  ],
  data: [
    "data engineer", "data pipeline", "etl", "spark", "airflow",
  ],
  intern: [
    "intern", "internship",
  ],
  senior: [
    "senior", "staff", "principal", "lead", "director",
  ],
  junior: [
    "junior", "associate", "entry level", "new grad",
  ],
  systems: [
    "c++", "rust", "fpga", "embedded", "systems",
    "kdb", "q language", "low latency",
  ],
};

/**
 * Extract tags from a job's title and department.
 * Returns a deduplicated array of tag strings.
 */
export function extractTags(title: string, department: string): string[] {
  const combined = `${title} ${department}`.toLowerCase();
  const tags = new Set<string>();

  for (const [tag, keywords] of Object.entries(TAG_KEYWORDS)) {
    if (keywords.some((kw) => combined.includes(kw))) {
      tags.add(tag);
    }
  }

  return Array.from(tags);
}
