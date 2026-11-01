import type { DocKind } from './assist/recommend.js';
import type { PMNode } from './doc.js';

export interface DocTemplate {
  id: string;
  name: string;
  kind: DocKind;
  description: string;
  style: 'apa' | 'ieee' | 'mla' | 'chicago';
  /** Page font defaults. */
  font: string;
  sections: string[];
  targetWords?: number;
  build(title: string): PMNode;
}

const h = (level: number, text: string): PMNode => ({ type: 'heading', attrs: { level }, content: text ? [{ type: 'text', text }] : undefined });
const p = (text = '', attrs: Record<string, unknown> = {}): PMNode => ({ type: 'paragraph', attrs, content: text ? [{ type: 'text', text }] : undefined });
const hint = (text: string) => p(text, { styleName: 'hint' });

function paper(title: string, sections: [string, string][], extra: PMNode[] = []): PMNode {
  return {
    type: 'doc',
    content: [
      p(title, { styleName: 'title', textAlign: 'center' }),
      p('Author Name · Affiliation · email@example.com', { styleName: 'subtitle', textAlign: 'center' }),
      ...extra,
      ...sections.flatMap(([s, help]) => (s === 'Abstract' ? [p('Abstract', { styleName: 'abstract-label' }), p(help, { styleName: 'abstract' })] : [h(1, s), hint(help)])),
      { type: 'bibliography' },
    ],
  };
}

export const DOC_TEMPLATES: DocTemplate[] = [
  { id: 'blank', name: 'Blank document', kind: 'document', description: 'An empty page.', style: 'apa', font: 'Calibri', sections: [], build: (t) => ({ type: 'doc', content: [p(t, { styleName: 'title' }), p()] }) },
  {
    id: 'ieee',
    name: 'IEEE conference paper',
    kind: 'paper',
    description: 'Abstract, keywords, numbered sections, IEEE citations.',
    style: 'ieee',
    font: 'Times New Roman',
    sections: ['Abstract', 'Introduction', 'Related Work', 'Method', 'Results', 'Discussion', 'Conclusion', 'References'],
    targetWords: 4000,
    build: (t) =>
      paper(t, [
        ['Abstract', 'In 150–250 words: the problem, your approach, the key quantitative result and why it matters.'],
        ['Introduction', 'Context and motivation, the gap in existing work, your contributions (as a list), and a roadmap of the paper.'],
        ['Related Work', 'Group prior work by theme; for each, say how yours differs.'],
        ['Method', 'System design, equations, setup, datasets and parameters — enough to reproduce.'],
        ['Results', 'Figures and tables with captions; describe what they show.'],
        ['Discussion', 'Interpretation, comparison with prior work, limitations.'],
        ['Conclusion', 'Main takeaway and future work.'],
      ], [p('Keywords — keyword one, keyword two, keyword three', { styleName: 'keywords' })]),
  },
  {
    id: 'apa',
    name: 'APA 7 student paper',
    kind: 'paper',
    description: 'Title page, abstract, APA headings and author–date citations.',
    style: 'apa',
    font: 'Times New Roman',
    sections: ['Abstract', 'Introduction', 'Method', 'Results', 'Discussion', 'References'],
    targetWords: 3000,
    build: (t) =>
      paper(t, [
        ['Abstract', 'A single paragraph of 150–250 words.'],
        ['Introduction', 'Introduce the problem, review the relevant literature and state your hypotheses.'],
        ['Method', 'Participants, materials and procedure.'],
        ['Results', 'Statistical results, with tables and figures.'],
        ['Discussion', 'Interpretation, limitations and implications.'],
      ]),
  },
  {
    id: 'review',
    name: 'Literature review',
    kind: 'review',
    description: 'Scope, search method, thematic synthesis, gaps.',
    style: 'apa',
    font: 'Calibri',
    sections: ['Abstract', 'Introduction', 'Method', 'Literature Review', 'Discussion', 'Conclusion', 'References'],
    targetWords: 5000,
    build: (t) =>
      paper(t, [
        ['Abstract', 'What was reviewed, how, and the main themes and gaps.'],
        ['Introduction', 'The topic, why a review is needed now, and the review questions.'],
        ['Method', 'Databases searched, search strings, inclusion/exclusion criteria and the screening counts (PRISMA).'],
        ['Literature Review', 'One subsection per theme. Compare and contrast studies; do not just summarise them one by one.'],
        ['Discussion', 'Patterns across themes, contradictions, and research gaps.'],
        ['Conclusion', 'Key findings of the review and an agenda for future research.'],
      ]),
  },
  {
    id: 'lab',
    name: 'Lab report',
    kind: 'lab',
    description: 'Aim, theory, apparatus, procedure, observations, results.',
    style: 'ieee',
    font: 'Calibri',
    sections: ['Aim', 'Theory', 'Apparatus', 'Procedure', 'Observations', 'Results', 'Conclusion', 'References'],
    build: (t) =>
      paper(t, [
        ['Aim', 'What the experiment sets out to determine.'],
        ['Theory', 'Governing equations and assumptions.'],
        ['Apparatus', 'Instruments with their ranges and least counts.'],
        ['Procedure', 'Numbered steps.'],
        ['Observations', 'A table of readings with units.'],
        ['Results', 'Calculated values, graphs and error analysis.'],
        ['Conclusion', 'Whether the aim was met, sources of error, precautions.'],
      ]),
  },
  {
    id: 'report',
    name: 'Technical / internship report',
    kind: 'report',
    description: 'Executive summary, background, work done, outcomes.',
    style: 'ieee',
    font: 'Calibri',
    sections: ['Executive Summary', 'Introduction', 'Background', 'Work Done', 'Results', 'Conclusion', 'References'],
    build: (t) =>
      paper(t, [
        ['Executive Summary', 'Half a page a manager could read on its own.'],
        ['Introduction', 'Organisation, team, and the objective of the work.'],
        ['Background', 'Concepts and tools needed to follow the report.'],
        ['Work Done', 'What you built or analysed, week by week or by module.'],
        ['Results', 'Outcomes, metrics, screenshots.'],
        ['Conclusion', 'Learning outcomes and recommendations.'],
      ]),
  },
  {
    id: 'thesis',
    name: 'Thesis chapter',
    kind: 'thesis',
    description: 'Chapter with numbered sections and a summary.',
    style: 'apa',
    font: 'Times New Roman',
    sections: ['Introduction', 'Literature Review', 'Method', 'Results', 'Discussion', 'Conclusion', 'References'],
    targetWords: 8000,
    build: (t) =>
      paper(t, [
        ['Introduction', 'Chapter aims and how it fits the thesis.'],
        ['Literature Review', 'Prior work by theme.'],
        ['Method', 'Approach in detail.'],
        ['Results', 'Findings.'],
        ['Discussion', 'Meaning and limitations.'],
        ['Conclusion', 'Chapter summary and link to the next chapter.'],
      ]),
  },
  {
    id: 'letter',
    name: 'Formal letter',
    kind: 'letter',
    description: 'Sender, date, recipient, subject, body, sign-off.',
    style: 'apa',
    font: 'Calibri',
    sections: [],
    build: () => ({
      type: 'doc',
      content: [p('Your Name\nAddress line\nemail@example.com', { textAlign: 'right' }), p(new Date().toDateString()), p('Recipient Name\nOrganisation\nAddress'), p('Subject: ', { styleName: 'strong' }), p('Dear Sir/Madam,'), p(''), p('Yours sincerely,'), p('Your Name')],
    }),
  },
];

export const getDocTemplate = (id: string) => DOC_TEMPLATES.find((t) => t.id === id) ?? DOC_TEMPLATES[0];
