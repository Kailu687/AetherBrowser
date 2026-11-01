import { createId, systemClock, type Clock, type Collection, type Id } from "@aether/research-core";
import type { StyleId } from "@aether/citations";
import type { AiContribution, Paper, Section } from "./model.js";
import { getTemplate } from "./templates.js";

const MAX_SNAPSHOTS = 30;

export class PaperStore {
  constructor(
    private readonly papers: Collection<Paper>,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(opts: { templateId: string; title?: string; workspaceId?: Id; style?: StyleId }): Promise<Paper> {
    const t = getTemplate(opts.templateId);
    if (!t) throw new Error(`Unknown template "${opts.templateId}"`);
    const now = this.clock.now().toISOString();
    const paper: Paper = {
      id: createId("paper"),
      createdAt: now,
      updatedAt: now,
      title: opts.title ?? "Untitled paper",
      templateId: t.id,
      style: opts.style ?? t.style,
      authors: [],
      sections: t.sections.map((s) => ({ ...s, id: createId("sec"), body: "" })),
      referenceIds: [],
      aiLog: [],
      snapshots: [],
      ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
    };
    await this.papers.put(paper);
    return paper;
  }

  get(id: Id) {
    return this.papers.get(id);
  }

  list(workspaceId?: Id) {
    return this.papers.list((p) => workspaceId === undefined || p.workspaceId === workspaceId);
  }

  delete(id: Id) {
    return this.papers.delete(id);
  }

  private async mutate(id: Id, fn: (p: Paper) => void): Promise<Paper> {
    const p = await this.papers.get(id);
    if (!p) throw new Error(`Paper ${id} not found`);
    fn(p);
    p.updatedAt = this.clock.now().toISOString();
    await this.papers.put(p);
    return p;
  }

  update(id: Id, patch: Partial<Pick<Paper, "title" | "style" | "authors" | "referenceIds" | "workspaceId">>) {
    return this.mutate(id, (p) => Object.assign(p, patch));
  }

  updateSection(id: Id, sectionId: Id, patch: Partial<Omit<Section, "id">>) {
    return this.mutate(id, (p) => {
      const s = p.sections.find((x) => x.id === sectionId);
      if (!s) throw new Error(`Section ${sectionId} not found`);
      Object.assign(s, patch);
    });
  }

  addSection(id: Id, heading: string, opts: { after?: Id; level?: 1 | 2 | 3 } = {}) {
    return this.mutate(id, (p) => {
      const sec: Section = { id: createId("sec"), heading, level: opts.level ?? 1, body: "", kind: "body" };
      const idx = opts.after ? p.sections.findIndex((s) => s.id === opts.after) : -1;
      p.sections.splice(idx >= 0 ? idx + 1 : p.sections.length, 0, sec);
    });
  }

  removeSection(id: Id, sectionId: Id) {
    return this.mutate(id, (p) => {
      p.sections = p.sections.filter((s) => s.id !== sectionId);
    });
  }

  moveSection(id: Id, sectionId: Id, delta: -1 | 1) {
    return this.mutate(id, (p) => {
      const i = p.sections.findIndex((s) => s.id === sectionId);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= p.sections.length) return;
      [p.sections[i], p.sections[j]] = [p.sections[j]!, p.sections[i]!];
    });
  }

  /** Add library references to the paper's bibliography. */
  addReferences(id: Id, refIds: string[]) {
    return this.mutate(id, (p) => {
      p.referenceIds = [...new Set([...p.referenceIds, ...refIds])];
    });
  }

  snapshot(id: Id, label?: string) {
    return this.mutate(id, (p) => {
      p.snapshots.push({ at: this.clock.now().toISOString(), label, title: p.title, sections: structuredClone(p.sections) });
      if (p.snapshots.length > MAX_SNAPSHOTS) p.snapshots.splice(0, p.snapshots.length - MAX_SNAPSHOTS);
    });
  }

  restore(id: Id, snapshotAt: string) {
    return this.mutate(id, (p) => {
      const snap = p.snapshots.find((s) => s.at === snapshotAt);
      if (!snap) throw new Error("Snapshot not found");
      p.snapshots.push({ at: this.clock.now().toISOString(), label: "Before restore", title: p.title, sections: structuredClone(p.sections) });
      p.sections = structuredClone(snap.sections);
      p.title = snap.title;
    });
  }

  /** Record an AI suggestion and whether the writer accepted it. Accepted text is applied to the section. */
  recordAi(id: Id, c: Omit<AiContribution, "id" | "at">, newBody?: string) {
    return this.mutate(id, (p) => {
      p.aiLog.push({ ...c, id: createId("aic"), at: this.clock.now().toISOString() });
      if (c.accepted && newBody !== undefined) {
        const s = p.sections.find((x) => x.id === c.sectionId);
        if (s) s.body = newBody;
      }
    });
  }
}
