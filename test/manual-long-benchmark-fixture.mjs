// Deterministic fixture for test/manual-long-benchmark.mjs: a synthetic Python
// project of 14 modules (about 400-900 lines each), two seeded bugs per module and
// one unittest file per module (126 tests). No real project content is used.
// The offline self-test in test/long-benchmark.test.mjs checks it.
//
//   longTask()                -> buggy project (the benchmark input)
//   longTask({ fixed: true }) -> the same project with every bug fixed

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Catalogue of utility functions. `good` is correct; `bad` carries the seeded
// bug. `tests` are assertions against module alias M.
const CATALOGUE = [
  {
    name: "paginate",
    sig: "def paginate(items, page, size):",
    doc: [
      "Return one page of ``items``.",
      "",
      "Pages are numbered from 1. A page past the end is empty.",
      "",
      "Args:",
      "    items: Any sliceable sequence.",
      "    page: 1-based page number.",
      "    size: Items per page.",
    ],
    good: [
      "if page < 1 or size < 1:",
      '    raise ValueError("page and size must be positive")',
      "start = (page - 1) * size",
      "return list(items[start:start + size])",
    ],
    bad: [
      "if page < 1 or size < 1:",
      '    raise ValueError("page and size must be positive")',
      "start = page * size",
      "return list(items[start:start + size])",
    ],
    tests: [
      "self.assertEqual(M.paginate(list(range(10)), 2, 3), [3, 4, 5])",
      "self.assertEqual(M.paginate(list(range(10)), 4, 3), [9])",
      "with self.assertRaises(ValueError):\n            M.paginate([], 0, 3)",
    ],
  },
  {
    name: "clamp",
    sig: "def clamp(value, low, high):",
    doc: ["Limit ``value`` to the closed interval [low, high]."],
    good: [
      "if low > high:",
      '    raise ValueError("low must not exceed high")',
      "return max(low, min(value, high))",
    ],
    bad: [
      "if low > high:",
      '    raise ValueError("low must not exceed high")',
      "return min(low, max(value, high))",
    ],
    tests: [
      "self.assertEqual(M.clamp(5, 0, 10), 5)",
      "self.assertEqual(M.clamp(-3, 0, 10), 0)",
      "self.assertEqual(M.clamp(42, 0, 10), 10)",
    ],
  },
  {
    name: "percent_change",
    sig: "def percent_change(old, new):",
    doc: [
      "Percentage change from ``old`` to ``new``, rounded to 2 places.",
      "",
      "The change is relative to the old value.",
    ],
    good: [
      "if old == 0:",
      '    raise ValueError("percent change from zero is undefined")',
      "return round((new - old) / abs(old) * 100, 2)",
    ],
    bad: [
      "if old == 0:",
      '    raise ValueError("percent change from zero is undefined")',
      "return round((new - old) / abs(new) * 100, 2)",
    ],
    tests: [
      "self.assertEqual(M.percent_change(50, 75), 50.0)",
      "self.assertEqual(M.percent_change(200, 150), -25.0)",
    ],
  },
  {
    name: "moving_average",
    sig: "def moving_average(values, window):",
    doc: [
      "Averages of every full window of ``window`` consecutive values.",
      "",
      "Each average is rounded to 3 places; a sequence of n values yields",
      "n - window + 1 averages.",
    ],
    good: [
      "if window < 1:",
      '    raise ValueError("window must be positive")',
      "averages = []",
      "for start in range(len(values) - window + 1):",
      "    chunk = values[start:start + window]",
      "    averages.append(round(sum(chunk) / window, 3))",
      "return averages",
    ],
    bad: [
      "if window < 1:",
      '    raise ValueError("window must be positive")',
      "averages = []",
      "for start in range(len(values) - window):",
      "    chunk = values[start:start + window]",
      "    averages.append(round(sum(chunk) / window, 3))",
      "return averages",
    ],
    tests: [
      "self.assertEqual(M.moving_average([1, 2, 3, 4], 2), [1.5, 2.5, 3.5])",
      "self.assertEqual(M.moving_average([2, 4, 6], 3), [4.0])",
    ],
  },
  {
    name: "top_n",
    sig: "def top_n(records, n, key):",
    doc: ["The ``n`` records with the largest ``key`` value, largest first."],
    good: [
      "return sorted(records, key=lambda record: record[key], reverse=True)[:n]",
    ],
    bad: ["return sorted(records, key=lambda record: record[key])[:n]"],
    tests: [
      'self.assertEqual(M.top_n([{"v": 1}, {"v": 5}, {"v": 3}], 2, "v"), [{"v": 5}, {"v": 3}])',
    ],
  },
  {
    name: "normalize_name",
    sig: "def normalize_name(text):",
    doc: ["Collapse whitespace and capitalise each word of a display name."],
    good: ['return " ".join(part.capitalize() for part in text.split())'],
    bad: [
      'return " ".join(part.capitalize() for part in text.strip().split(" "))',
    ],
    tests: [
      'self.assertEqual(M.normalize_name("  ada   lovelace "), "Ada Lovelace")',
      'self.assertEqual(M.normalize_name("GRACE hopper"), "Grace Hopper")',
    ],
  },
  {
    name: "parse_code",
    sig: "def parse_code(code):",
    doc: [
      "Split a record code into (prefix, number).",
      "",
      "The number follows the last hyphen; the prefix may itself contain",
      'hyphens, e.g. "WH-EU-0042" -> ("WH-EU", 42). Prefixes are upper-cased.',
    ],
    good: [
      'prefix, _, number = code.rpartition("-")',
      "if not prefix or not number.isdigit():",
      '    raise ValueError(f"malformed code: {code!r}")',
      "return prefix.upper(), int(number)",
    ],
    bad: [
      'prefix, _, number = code.partition("-")',
      "if not prefix or not number.isdigit():",
      '    raise ValueError(f"malformed code: {code!r}")',
      "return prefix.upper(), int(number)",
    ],
    tests: [
      'self.assertEqual(M.parse_code("WH-EU-0042"), ("WH-EU", 42))',
      'self.assertEqual(M.parse_code("inv-7"), ("INV", 7))',
    ],
  },
  {
    name: "total_value",
    sig: "def total_value(records):",
    doc: ["Sum of price * quantity over ``records``, rounded to 2 places."],
    good: [
      'return round(sum(record["price"] * record["quantity"] for record in records), 2)',
    ],
    bad: [
      'prices = sum(record["price"] for record in records)',
      'quantities = sum(record["quantity"] for record in records)',
      "return round(prices * quantities, 2)",
    ],
    tests: [
      'self.assertEqual(M.total_value([{"price": 2.5, "quantity": 4}, {"price": 1.0, "quantity": 3}]), 13.0)',
      "self.assertEqual(M.total_value([]), 0)",
    ],
  },
  {
    name: "group_by",
    sig: "def group_by(records, field):",
    doc: [
      "Map each distinct ``field`` value to the records that carry it, in order.",
    ],
    good: [
      "groups = {}",
      "for record in records:",
      "    groups.setdefault(record[field], []).append(record)",
      "return groups",
    ],
    bad: [
      "groups = {}",
      "for record in records:",
      "    groups[record[field]] = [record]",
      "return groups",
    ],
    tests: [
      'rows = [{"r": "n", "i": 1}, {"r": "s", "i": 2}, {"r": "n", "i": 3}]',
      'self.assertEqual([row["i"] for row in M.group_by(rows, "r")["n"]], [1, 3])',
    ],
  },
  {
    name: "weighted_mean",
    sig: "def weighted_mean(values, weights):",
    doc: ["Mean of ``values`` weighted by ``weights``."],
    good: [
      "if len(values) != len(weights) or not sum(weights):",
      '    raise ValueError("values and weights must align and weights must not sum to zero")',
      "return sum(v * w for v, w in zip(values, weights)) / sum(weights)",
    ],
    bad: [
      "if len(values) != len(weights) or not sum(weights):",
      '    raise ValueError("values and weights must align and weights must not sum to zero")',
      "return sum(v * w for v, w in zip(values, weights)) / len(values)",
    ],
    tests: ["self.assertEqual(M.weighted_mean([10, 20], [1, 3]), 17.5)"],
  },
  {
    name: "is_leap_year",
    sig: "def is_leap_year(year):",
    doc: ["Gregorian leap-year rule."],
    good: ["return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)"],
    bad: ["return year % 4 == 0 and year % 100 != 0"],
    tests: [
      "self.assertTrue(M.is_leap_year(2000))",
      "self.assertFalse(M.is_leap_year(1900))",
      "self.assertTrue(M.is_leap_year(2024))",
    ],
  },
  {
    name: "apply_discount",
    sig: "def apply_discount(price, percent):",
    doc: ["Price after a ``percent`` discount, rounded to 2 places."],
    good: [
      "if not 0 <= percent <= 100:",
      '    raise ValueError("percent must be between 0 and 100")',
      "return round(price * (100 - percent) / 100, 2)",
    ],
    bad: [
      "if not 0 <= percent <= 100:",
      '    raise ValueError("percent must be between 0 and 100")',
      "return round(price * percent / 100, 2)",
    ],
    tests: [
      "self.assertEqual(M.apply_discount(80.0, 25), 60.0)",
      "self.assertEqual(M.apply_discount(19.99, 0), 19.99)",
    ],
  },
  {
    name: "median",
    sig: "def median(values):",
    doc: [
      "Median of ``values``; the mean of the middle two for an even count.",
    ],
    good: [
      "ordered = sorted(values)",
      "if not ordered:",
      '    raise ValueError("median of empty data")',
      "middle = len(ordered) // 2",
      "if len(ordered) % 2:",
      "    return ordered[middle]",
      "return (ordered[middle - 1] + ordered[middle]) / 2",
    ],
    bad: [
      "ordered = sorted(values)",
      "if not ordered:",
      '    raise ValueError("median of empty data")',
      "middle = len(ordered) // 2",
      "if len(ordered) % 2:",
      "    return ordered[middle]",
      "return ordered[middle]",
    ],
    tests: [
      "self.assertEqual(M.median([4, 1, 3, 2]), 2.5)",
      "self.assertEqual(M.median([5, 1, 3]), 3)",
    ],
  },
  {
    name: "dedupe",
    sig: "def dedupe(items):",
    doc: [
      "Drop repeated items, keeping the first occurrence and the original order.",
    ],
    good: [
      "seen = set()",
      "result = []",
      "for item in items:",
      "    if item not in seen:",
      "        seen.add(item)",
      "        result.append(item)",
      "return result",
    ],
    bad: ["return sorted(set(items), key=str)"],
    tests: [
      'self.assertEqual(M.dedupe(["b", "a", "b", "c", "a"]), ["b", "a", "c"])',
    ],
  },
  {
    name: "chunk",
    sig: "def chunk(items, size):",
    doc: [
      "Split ``items`` into lists of ``size``; the last one may be shorter.",
    ],
    good: [
      "if size < 1:",
      '    raise ValueError("size must be positive")',
      "return [list(items[i:i + size]) for i in range(0, len(items), size)]",
    ],
    bad: [
      "if size < 1:",
      '    raise ValueError("size must be positive")',
      "return [list(items[i:i + size]) for i in range(0, len(items) - size + 1, size)]",
    ],
    tests: [
      "self.assertEqual(M.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])",
    ],
  },
  {
    name: "merge_ranges",
    sig: "def merge_ranges(ranges):",
    doc: [
      "Merge overlapping or touching closed (start, end) ranges.",
      "",
      "Ranges that share an endpoint are merged; the result is sorted.",
    ],
    good: [
      "merged = []",
      "for start, end in sorted(ranges):",
      "    if merged and start <= merged[-1][1]:",
      "        merged[-1] = (merged[-1][0], max(merged[-1][1], end))",
      "    else:",
      "        merged.append((start, end))",
      "return merged",
    ],
    bad: [
      "merged = []",
      "for start, end in sorted(ranges):",
      "    if merged and start < merged[-1][1]:",
      "        merged[-1] = (merged[-1][0], max(merged[-1][1], end))",
      "    else:",
      "        merged.append((start, end))",
      "return merged",
    ],
    tests: [
      "self.assertEqual(M.merge_ranges([(5, 8), (1, 3), (3, 4)]), [(1, 4), (5, 8)])",
    ],
  },
  {
    name: "days_between",
    sig: "def days_between(first, second):",
    doc: [
      "Whole days between two ISO dates, in either order (never negative).",
    ],
    good: [
      "delta = date.fromisoformat(second) - date.fromisoformat(first)",
      "return abs(delta.days)",
    ],
    bad: [
      "delta = date.fromisoformat(second) - date.fromisoformat(first)",
      "return delta.days",
    ],
    tests: [
      'self.assertEqual(M.days_between("2026-03-10", "2026-03-01"), 9)',
      'self.assertEqual(M.days_between("2026-03-01", "2026-03-10"), 9)',
    ],
  },
  {
    name: "format_money",
    sig: "def format_money(cents):",
    doc: ['Format integer cents as a decimal string, e.g. 1205 -> "12.05".'],
    good: [
      'sign = "-" if cents < 0 else ""',
      "cents = abs(cents)",
      'return f"{sign}{cents // 100}.{cents % 100:02d}"',
    ],
    bad: [
      'sign = "-" if cents < 0 else ""',
      "cents = abs(cents)",
      'return f"{sign}{cents // 100}.{cents % 100}"',
    ],
    tests: [
      'self.assertEqual(M.format_money(1205), "12.05")',
      'self.assertEqual(M.format_money(-250), "-2.50")',
    ],
  },
  {
    name: "missing_fields",
    sig: "def missing_fields(record, required):",
    doc: ["Required fields that are absent, None or empty strings, in order."],
    good: [
      'return [field for field in required if record.get(field) in (None, "")]',
    ],
    bad: ["return [field for field in required if field not in record]"],
    tests: [
      'self.assertEqual(M.missing_fields({"a": 1, "b": ""}, ["a", "b", "c"]), ["b", "c"])',
    ],
  },
  {
    name: "safe_ratio",
    sig: "def safe_ratio(numerator, denominator):",
    doc: ["``numerator / denominator``, or 0.0 when the denominator is zero."],
    good: [
      "if denominator == 0:",
      "    return 0.0",
      "return numerator / denominator",
    ],
    bad: [
      "if numerator == 0:",
      "    return 0.0",
      "return numerator / denominator",
    ],
    tests: [
      "self.assertEqual(M.safe_ratio(5, 0), 0.0)",
      "self.assertEqual(M.safe_ratio(3, 4), 0.75)",
    ],
  },
  {
    name: "bucket_for",
    sig: "def bucket_for(value, thresholds):",
    doc: [
      "Label of the first (upper_bound, label) pair with value <= upper_bound.",
      "",
      'Upper bounds are inclusive. Values above every bound are "overflow".',
    ],
    good: [
      "for upper, label in thresholds:",
      "    if value <= upper:",
      "        return label",
      'return "overflow"',
    ],
    bad: [
      "for upper, label in thresholds:",
      "    if value < upper:",
      "        return label",
      'return "overflow"',
    ],
    tests: [
      'bands = [(10, "small"), (100, "medium")]',
      'self.assertEqual(M.bucket_for(10, bands), "small")',
      'self.assertEqual(M.bucket_for(500, bands), "overflow")',
    ],
  },
  {
    name: "retry_delays",
    sig: "def retry_delays(base, attempts, cap):",
    doc: [
      "Exponential back-off delays: base * 2**n for each attempt, capped at ``cap``.",
    ],
    good: [
      "return [min(cap, base * 2 ** attempt) for attempt in range(attempts)]",
    ],
    bad: [
      "return [min(cap, base * 2 * attempt) for attempt in range(attempts)]",
    ],
    tests: [
      "self.assertEqual(M.retry_delays(0.5, 4, 10), [0.5, 1.0, 2.0, 4.0])",
      "self.assertEqual(M.retry_delays(4, 3, 10), [4, 8, 10])",
    ],
  },
  {
    name: "invert_mapping",
    sig: "def invert_mapping(mapping):",
    doc: ["Map values back to keys; for repeated values the first key wins."],
    good: [
      "inverted = {}",
      "for key, value in mapping.items():",
      "    inverted.setdefault(value, key)",
      "return inverted",
    ],
    bad: [
      "inverted = {}",
      "for key, value in mapping.items():",
      "    inverted[value] = key",
      "return inverted",
    ],
    tests: [
      'self.assertEqual(M.invert_mapping({"a": 1, "b": 2, "c": 1}), {1: "a", 2: "b"})',
    ],
  },
  {
    name: "compound",
    sig: "def compound(principal, rate, years):",
    doc: ["Value after annual compounding, rounded to 2 places."],
    good: ["return round(principal * (1 + rate) ** years, 2)"],
    bad: ["return round(principal * (1 + rate * years), 2)"],
    tests: ["self.assertEqual(M.compound(1000, 0.05, 2), 1102.5)"],
  },
  {
    name: "truncate",
    sig: "def truncate(text, limit):",
    doc: [
      'Shorten ``text`` to at most ``limit`` characters, ending in "..." when cut.',
    ],
    good: [
      "if len(text) <= limit:",
      "    return text",
      'return text[:max(0, limit - 3)].rstrip() + "..."',
    ],
    bad: [
      "if len(text) <= limit:",
      "    return text",
      'return text[:limit].rstrip() + "..."',
    ],
    tests: [
      'self.assertEqual(M.truncate("abcdefghij", 8), "abcde...")',
      'self.assertEqual(M.truncate("short", 8), "short")',
    ],
  },
  {
    name: "cumulative",
    sig: "def cumulative(values):",
    doc: ["Running totals of ``values``."],
    good: [
      "total = 0",
      "result = []",
      "for value in values:",
      "    total += value",
      "    result.append(total)",
      "return result",
    ],
    bad: [
      "total = 0",
      "result = []",
      "for value in values:",
      "    result.append(total)",
      "    total += value",
      "return result",
    ],
    tests: ["self.assertEqual(M.cumulative([1, 2, 3]), [1, 3, 6])"],
  },
  {
    name: "rank_scores",
    sig: "def rank_scores(scores):",
    doc: ["Dense rank of each name by score, highest score ranked 1."],
    good: [
      "distinct = sorted(set(scores.values()), reverse=True)",
      "position = {score: index + 1 for index, score in enumerate(distinct)}",
      "return {name: position[score] for name, score in scores.items()}",
    ],
    bad: [
      "distinct = sorted(set(scores.values()), reverse=True)",
      "position = {score: index for index, score in enumerate(distinct)}",
      "return {name: position[score] for name, score in scores.items()}",
    ],
    tests: [
      'self.assertEqual(M.rank_scores({"a": 90, "b": 75, "c": 90}), {"a": 1, "b": 2, "c": 1})',
    ],
  },
  {
    name: "split_evenly",
    sig: "def split_evenly(total_cents, parts):",
    doc: [
      "Split integer cents into ``parts`` shares that differ by at most one cent.",
      "",
      "The first shares receive the remainder.",
    ],
    good: [
      "if parts < 1:",
      '    raise ValueError("parts must be positive")',
      "share, remainder = divmod(total_cents, parts)",
      "return [share + (1 if index < remainder else 0) for index in range(parts)]",
    ],
    bad: [
      "if parts < 1:",
      '    raise ValueError("parts must be positive")',
      "share, remainder = divmod(total_cents, parts)",
      "return [share + (1 if index <= remainder else 0) for index in range(parts)]",
    ],
    tests: [
      "self.assertEqual(M.split_evenly(100, 3), [34, 33, 33])",
      "self.assertEqual(sum(M.split_evenly(1001, 7)), 1001)",
    ],
  },
  {
    name: "overlaps",
    sig: "def overlaps(a_start, a_end, b_start, b_end):",
    doc: [
      "Whether half-open intervals [a_start, a_end) and [b_start, b_end) overlap.",
    ],
    good: ["return a_start < b_end and b_start < a_end"],
    bad: ["return a_start <= b_end and b_start <= a_end"],
    tests: [
      "self.assertFalse(M.overlaps(1, 5, 5, 9))",
      "self.assertTrue(M.overlaps(1, 5, 4, 9))",
    ],
  },
];

const DOMAINS = [
  [
    "inventory",
    "Inventory",
    "INV",
    ["price", "quantity", "reorder_level"],
    "Stock levels and reorder points for the regional stores.",
  ],
  [
    "billing",
    "Billing",
    "BIL",
    ["price", "quantity", "tax_rate"],
    "Invoice lines, tax rates and settlement helpers.",
  ],
  [
    "shipping",
    "Shipping",
    "SHP",
    ["price", "quantity", "weight_kg"],
    "Parcel rates, carrier legs and delivery windows.",
  ],
  [
    "payroll",
    "Payroll",
    "PAY",
    ["price", "quantity", "overtime_hours"],
    "Pay grades, hours and payroll period arithmetic.",
  ],
  [
    "scheduling",
    "Scheduling",
    "SCH",
    ["price", "quantity", "slot_minutes"],
    "Room bookings, slots and calendar arithmetic.",
  ],
  [
    "catalog",
    "Catalog",
    "CAT",
    ["price", "quantity", "rating"],
    "Product catalogue entries and search ranking.",
  ],
  [
    "warehouse",
    "Warehouse",
    "WH-EU",
    ["price", "quantity", "bin_level"],
    "Bin locations, pick lists and stock transfers.",
  ],
  [
    "subscriptions",
    "Subscriptions",
    "SUB",
    ["price", "quantity", "term_months"],
    "Subscription plans, renewals and proration.",
  ],
  [
    "analytics",
    "Analytics",
    "ANL",
    ["price", "quantity", "sessions"],
    "Traffic metrics, rollups and trend reporting.",
  ],
  [
    "loyalty",
    "Loyalty",
    "LOY",
    ["price", "quantity", "points"],
    "Loyalty tiers, points balances and rewards.",
  ],
  [
    "ticketing",
    "Ticketing",
    "TKT",
    ["price", "quantity", "priority"],
    "Support tickets, queues and service levels.",
  ],
  [
    "fleet",
    "Fleet",
    "FLT",
    ["price", "quantity", "odometer_km"],
    "Vehicles, maintenance intervals and fuel use.",
  ],
  [
    "energy",
    "Energy",
    "NRG",
    ["price", "quantity", "kwh"],
    "Meter readings, tariffs and consumption bands.",
  ],
  [
    "library",
    "Library",
    "LIB",
    ["price", "quantity", "loan_days"],
    "Lending catalogue, loans and overdue fines.",
  ],
];

const REGIONS = ["north", "south", "east", "west", "central"];
const WORDS = [
  "amber",
  "basalt",
  "cedar",
  "delta",
  "ember",
  "fjord",
  "garnet",
  "harbor",
  "indigo",
  "juniper",
  "kestrel",
  "lumen",
  "meadow",
  "nimbus",
  "onyx",
  "prairie",
  "quartz",
  "russet",
  "sierra",
  "tundra",
  "umber",
  "vesper",
  "willow",
  "xenon",
  "yarrow",
  "zephyr",
];
const NOUNS = [
  "bracket",
  "cable",
  "drum",
  "filter",
  "gasket",
  "hinge",
  "valve",
  "lens",
  "panel",
  "relay",
  "sensor",
  "spindle",
  "switch",
  "tile",
  "washer",
  "module",
];

const PAD = (n, w = 4) => String(n).padStart(w, "0");
const indent = (lines, by) => lines.map((l) => (l ? " ".repeat(by) + l : l));

function functionSource(entry, buggy) {
  const body = buggy ? entry.bad : entry.good;
  const doc =
    entry.doc.length === 1
      ? [`"""${entry.doc[0]}"""`]
      : ['"""' + entry.doc[0], ...entry.doc.slice(1), '"""'];
  return [entry.sig, ...indent(doc, 4), ...indent(body, 4)].join("\n");
}

function moduleSource(d, index, rand, fixed) {
  const [mod, Title, prefix, fields, blurb] = d;
  const extra = fields[2];
  const target = 400 + Math.floor(rand() * 501); // 400..900 lines
  const bugs = [2 * index, 2 * index + 1];
  const others = [];
  for (let k = 0; others.length < 4; k++) {
    const c = (2 * index + 3 + 5 * k) % CATALOGUE.length;
    if (!bugs.includes(c) && !others.includes(c)) others.push(c);
  }
  const helpers = [
    bugs[0],
    others[0],
    others[1],
    bugs[1],
    others[2],
    others[3],
  ];

  const header = [
    `"""${Title} service helpers.`,
    "",
    blurb,
    "",
    "This module keeps a static reference table (RECORDS) that mirrors the",
    "nightly export, plus small pure helpers used by the reporting jobs.",
    "The table is generated data: do not edit it by hand.",
    '"""',
    "",
    "from datetime import date",
    "",
    `MODULE_NAME = "${mod}"`,
    `CODE_PREFIX = "${prefix}"`,
    `REGIONS = (${REGIONS.map((r) => `"${r}"`).join(", ")})`,
    `NUMERIC_FIELDS = ("price", "quantity", "${extra}")`,
    "",
    "",
  ].join("\n");

  // Domain helpers (always correct).
  const domain = `def find_record(code):
    """Return the record with the given code, or None when it is unknown."""
    for record in RECORDS:
        if record["code"] == code:
            return record
    return None


def records_in_region(region):
    """Records whose region matches the given region (case-insensitive)."""
    wanted = region.lower()
    if wanted not in REGIONS:
        raise ValueError(f"unknown region: {region!r}")
    return [record for record in RECORDS if record["region"] == wanted]


def region_totals(field):
    """Sum a numeric field per region, rounded to 2 places."""
    if field not in NUMERIC_FIELDS:
        raise KeyError(field)
    totals = {}
    for record in RECORDS:
        region = record["region"]
        totals[region] = round(totals.get(region, 0) + record[field], 2)
    return totals


class ${Title}Book:
    """Read-only view over a list of ${mod} records."""

    def __init__(self, records=None):
        self._records = list(RECORDS if records is None else records)

    def __len__(self):
        return len(self._records)

    def codes(self):
        """All record codes, sorted."""
        return sorted(record["code"] for record in self._records)

    def active(self):
        """Records that are currently active."""
        return [record for record in self._records if record["active"]]

    def summary(self):
        """Counts used by the nightly ${mod} report."""
        return {
            "count": len(self._records),
            "active": len(self.active()),
            "regions": sorted({record["region"] for record in self._records}),
        }
`;

  const funcs = helpers
    .map((c) => functionSource(CATALOGUE[c], !fixed && bugs.includes(c)))
    .join("\n\n\n");
  const fixedLines = (header + domain + "\n\n" + funcs).split("\n").length + 4;
  const recordLines = 11;
  const count = Math.max(12, Math.floor((target - fixedLines) / recordLines));
  const records = [];
  for (let n = 1; n <= count; n++) {
    const name = `${WORDS[Math.floor(rand() * WORDS.length)]} ${NOUNS[Math.floor(rand() * NOUNS.length)]}`;
    records.push({
      code: `${prefix}-${PAD(n)}`,
      name,
      region: REGIONS[Math.floor(rand() * REGIONS.length)],
      price: Math.round(rand() * 50000) / 100,
      quantity: 1 + Math.floor(rand() * 400),
      extra: Math.round(rand() * 1000) / 10,
      active: rand() > 0.25,
      updated: `2026-${PAD(1 + Math.floor(rand() * 10), 2)}-${PAD(1 + Math.floor(rand() * 28), 2)}`,
    });
  }
  const table =
    "RECORDS = [\n" +
    records
      .map((r) =>
        [
          "    {",
          `        "code": "${r.code}",`,
          `        "name": "${r.name}",`,
          `        "region": "${r.region}",`,
          `        "price": ${r.price.toFixed(2)},`,
          `        "quantity": ${r.quantity},`,
          `        "${extra}": ${r.extra.toFixed(1)},`,
          `        "active": ${r.active ? "True" : "False"},`,
          `        "updated": "${r.updated}",`,
          `        "notes": "${r.name} stocked for the ${r.region} region",`,
          "    },",
        ].join("\n"),
      )
      .join("\n") +
    "\n]\n";

  // Domain functions first, then table, then the utility helpers so the bugs
  // sit below the data, past the first page of a paged read.
  const source = header + table + "\n\n" + domain + "\n\n" + funcs + "\n";

  const first = records[0];
  const northCount = records.filter((r) => r.region === "north").length;
  const activeCount = records.filter((r) => r.active).length;
  const testLines = [
    "import unittest",
    "",
    `import ${mod} as M`,
    "",
    "",
    `class ${Title}Tests(unittest.TestCase):`,
    "    def test_find_record(self):",
    `        self.assertEqual(M.find_record("${first.code}")["name"], "${first.name}")`,
    `        self.assertIsNone(M.find_record("${prefix}-9999"))`,
    "",
    "    def test_records_in_region(self):",
    `        self.assertEqual(len(M.records_in_region("North")), ${northCount})`,
    "",
    "    def test_book_summary(self):",
    `        book = M.${Title}Book()`,
    `        self.assertEqual(book.summary()["count"], ${records.length})`,
    `        self.assertEqual(book.summary()["active"], ${activeCount})`,
    "",
  ];
  for (const c of helpers) {
    const entry = CATALOGUE[c];
    testLines.push(`    def test_${entry.name}(self):`);
    for (const t of entry.tests) testLines.push("        " + t);
    testLines.push("");
  }
  testLines.push("", 'if __name__ == "__main__":', "    unittest.main()", "");

  return {
    source,
    table,
    test: testLines.join("\n"),
    bugs: bugs.map((c) => `${mod}.${CATALOGUE[c].name}`),
    tests: 3 + helpers.length,
  };
}

export function longTask({ fixed = false } = {}) {
  const rand = mulberry32(20261115);
  const files = {},
    tables = {},
    tests = {},
    bugs = [];
  let testCount = 0;
  DOMAINS.forEach((d, index) => {
    const m = moduleSource(d, index, rand, fixed);
    files[`${d[0]}.py`] = m.source;
    files[`test_${d[0]}.py`] = m.test;
    tables[`${d[0]}.py`] = m.table;
    tests[`test_${d[0]}.py`] = m.test;
    bugs.push(...m.bugs);
    testCount += m.tests;
  });
  files["README.md"] =
    "# Operations helpers\n\nSmall pure-Python helpers for the nightly reports.\n" +
    "Each module has a unittest file. Run the suite with `python3 -m unittest`.\n" +
    "The RECORDS tables are generated data and must not be edited by hand.\n";
  return {
    files,
    tables,
    tests,
    bugs,
    testCount,
    prompt:
      "The unit test suite in this Python project is failing. Run python3 -m unittest to see the failures, " +
      "then fix the bugs in the modules so that every test passes. Keep the RECORDS data tables, the tests and the " +
      "public function signatures unchanged, and make minimal edits to the existing modules. When you are done, run " +
      "the full suite again and report what passed. Do not rewrite the tests, install dependencies or use the network.",
  };
}
