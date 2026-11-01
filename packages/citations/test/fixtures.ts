import type { Reference } from "@aether/citations";

export const journal: Reference = {
  id: "he2016deep",
  type: "article-journal",
  title: "Deep residual learning for image recognition",
  author: [
    { family: "He", given: "Kaiming" },
    { family: "Zhang", given: "Xiangyu" },
    { family: "Ren", given: "Shaoqing" },
    { family: "Sun", given: "Jian" },
  ],
  issued: { "date-parts": [[2016, 6]] },
  "container-title": "IEEE Transactions on Pattern Analysis",
  volume: 38,
  issue: 4,
  page: "770-778",
  DOI: "10.1109/CVPR.2016.90",
};

export const book: Reference = {
  id: "sedra2015",
  type: "book",
  title: "Microelectronic Circuits",
  author: [{ family: "Sedra", given: "Adel S." }, { family: "Smith", given: "Kenneth C." }],
  edition: 7,
  publisher: "Oxford University Press",
  "publisher-place": "New York, NY, USA",
  issued: { "date-parts": [[2015]] },
};

export const preprint: Reference = {
  id: "vaswani2017attention",
  type: "article",
  title: "Attention is all you need",
  author: [{ family: "Vaswani", given: "Ashish" }, { family: "Shazeer", given: "Noam" }],
  issued: { "date-parts": [[2017]] },
  archive: "arXiv",
  archive_location: "1706.03762",
};

export const web: Reference = {
  id: "ti2023",
  type: "webpage",
  title: "LM741 operational amplifier datasheet",
  author: [{ literal: "Texas Instruments" }],
  "container-title": "Texas Instruments",
  issued: { "date-parts": [[2023, 3, 14]] },
  accessed: { "date-parts": [[2026, 10, 1]] },
  URL: "https://www.ti.com/lit/ds/symlink/lm741.pdf",
};

export const conf: Reference = {
  id: "smith2020",
  type: "paper-conference",
  title: "A low-power SAR ADC",
  author: [{ family: "Smith", given: "Jane" }],
  "container-title": "Proc. IEEE Int. Solid-State Circuits Conf.",
  "event-place": "San Francisco, CA, USA",
  issued: { "date-parts": [[2020, 2]] },
  page: "100-102",
};
