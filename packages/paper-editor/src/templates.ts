import type { StyleId } from "@aether/citations";
import type { Section } from "./model.js";

export interface PaperTemplate {
  id: string;
  name: string;
  description: string;
  style: StyleId;
  /** LaTeX document class used on export. */
  latexClass: "IEEEtran" | "article" | "report";
  sections: Array<Omit<Section, "id" | "body">>;
}

const s = (heading: string, hint: string, extra: Partial<Section> = {}): Omit<Section, "id" | "body"> => ({ heading, hint, level: 1, kind: "body", ...extra });

export const TEMPLATES: PaperTemplate[] = [
  {
    id: "ieee-conference",
    name: "IEEE conference paper",
    description: "Two-column IEEEtran layout with numbered references, 4–6 pages.",
    style: "ieee",
    latexClass: "IEEEtran",
    sections: [
      s("Abstract", "150–250 words: problem, approach, key quantitative result, significance. No citations.", { kind: "abstract", targetWords: [150, 250] }),
      s("Index Terms", "4–8 keywords, comma-separated.", { kind: "keywords" }),
      s("Introduction", "Motivate the problem, summarise prior approaches with citations, state the gap and your contributions as a list.", { expectsCitations: true, targetWords: [400, 900] }),
      s("Related Work", "Group prior work by approach; compare explicitly to yours.", { expectsCitations: true }),
      s("Methodology", "System model, assumptions, design or algorithm, with equations numbered."),
      s("Experimental Setup", "Hardware/software, datasets, parameters and metrics so others can reproduce it."),
      s("Results and Discussion", "Figures/tables with quantitative comparison to baselines; explain why, including limitations."),
      s("Conclusion", "Restate contributions and results; future work. No new results."),
      s("Acknowledgment", "Funding and help (IEEE spelling: Acknowledgment).", { kind: "acknowledgements" }),
    ],
  },
  {
    id: "apa-research",
    name: "Research paper (APA 7)",
    description: "Student or professional paper in APA style with author-date citations.",
    style: "apa",
    latexClass: "article",
    sections: [
      s("Abstract", "150–250 words summarising purpose, method, results and conclusions.", { kind: "abstract", targetWords: [150, 250] }),
      s("Keywords", "3–5 keywords.", { kind: "keywords" }),
      s("Introduction", "Background, literature, research question and hypotheses.", { expectsCitations: true }),
      s("Method", "Participants/materials, design, procedure."),
      s("Results", "Findings with statistics; no interpretation."),
      s("Discussion", "Interpret results against the literature; limitations; implications.", { expectsCitations: true }),
    ],
  },
  {
    id: "literature-review",
    name: "Literature review",
    description: "Thematic synthesis of prior work with a comparison table and research gaps.",
    style: "apa",
    latexClass: "article",
    sections: [
      s("Abstract", "Scope of the review, how sources were selected, main themes and gaps.", { kind: "abstract" }),
      s("Introduction", "Topic, why it matters, review questions, scope.", { expectsCitations: true }),
      s("Search Methodology", "Databases, search strings, inclusion/exclusion criteria, number of papers screened."),
      s("Thematic Review", "One subsection per theme; synthesise and compare rather than summarising paper by paper.", { expectsCitations: true }),
      s("Comparison of Approaches", "Table comparing methods, datasets, metrics and results.", { expectsCitations: true }),
      s("Research Gaps and Future Directions", "What is unresolved and why.", { expectsCitations: true }),
      s("Conclusion", "Key takeaways."),
    ],
  },
  {
    id: "lab-report",
    name: "Engineering lab report",
    description: "University lab write-up: aim, theory, procedure, observations, calculations.",
    style: "ieee",
    latexClass: "article",
    sections: [
      s("Aim", "One or two sentences on what the experiment verifies or measures."),
      s("Apparatus", "List of equipment and components with ratings/part numbers."),
      s("Theory", "Governing equations with symbols defined.", { expectsCitations: true }),
      s("Procedure", "Numbered steps someone else could follow."),
      s("Observations", "Tables of measured values with units."),
      s("Calculations", "Worked calculations from observations; show one sample calculation fully."),
      s("Results and Discussion", "Compare measured and theoretical values, percentage error and sources of error."),
      s("Conclusion", "Whether the aim was achieved, with the key number."),
    ],
  },
  {
    id: "technical-report",
    name: "Technical / internship report",
    description: "Report for an internship, project review or design document.",
    style: "ieee",
    latexClass: "report",
    sections: [
      s("Executive Summary", "Half a page: what was done, outcome, recommendation.", { kind: "abstract" }),
      s("Introduction", "Organisation/context, problem statement, objectives."),
      s("Background", "Technologies and prior work needed to understand the report.", { expectsCitations: true }),
      s("Design and Implementation", "Architecture, key decisions and trade-offs."),
      s("Testing and Results", "Test plan, results, metrics."),
      s("Challenges and Lessons Learned", "What went wrong and what you would change."),
      s("Conclusion and Recommendations", "Outcomes and next steps."),
    ],
  },
  {
    id: "thesis-chapter",
    name: "Thesis chapter",
    description: "One chapter of a B.Tech/M.Tech/PhD thesis.",
    style: "ieee",
    latexClass: "report",
    sections: [
      s("Introduction", "What this chapter covers and how it connects to the thesis.", {}),
      s("Background", "Theory and prior work this chapter builds on.", { expectsCitations: true }),
      s("Main Content", "Your contribution, organised in subsections."),
      s("Summary", "Key findings and link to the next chapter."),
    ],
  },
  {
    id: "blank",
    name: "Blank document",
    description: "Start from an empty page.",
    style: "apa",
    latexClass: "article",
    sections: [s("Introduction", "")],
  },
];

export const getTemplate = (id: string) => TEMPLATES.find((t) => t.id === id);
