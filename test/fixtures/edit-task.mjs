// Synthetic, stable multi-file fixture. No owner project content is used.
export function editTask() {
  const table = (name, count) =>
    `${name} = {\n` +
    Array.from(
      { length: count },
      (_, n) =>
        `    "stage_${String(n + 1).padStart(3, "0")}": (${n + 1}, "Stage ${n + 1}: collect tokens, avoid hazards, reach the exit"),\n`,
    ).join("") +
    "}\n\n";
  const files = {
    "scoring.py":
      table("STAGES", 340) +
      `def award_score(current, tokens, multiplier=1):
    """Award tokens multiplied by the selected multiplier."""
    return current + tokens + multiplier


def spend_score(current, cost):
    """Spend points; a score must never become negative."""
    return current - cost
`,
    "player.py":
      table("STAGES", 350) +
      `def take_damage(health, damage):
    """Damage reduces health, with zero as the lower bound."""
    return health + damage


def heal(health, amount, maximum=100):
    """Healing must not exceed maximum health."""
    return health + amount
`,
    "progress.py":
      table("STAGES", 360) +
      `def unlocked(stars, required):
    """A player meeting the required stars can unlock a stage."""
    return stars > required


def remaining(total, finished):
    """Return unfinished stages, clamped at zero."""
    return total - finished
`,
    "test_game.py": `import unittest
from scoring import award_score, spend_score
from player import take_damage, heal
from progress import unlocked, remaining

class GameRules(unittest.TestCase):
    def test_award(self):
        self.assertEqual(award_score(10, 3, 2), 16)
    def test_spend(self):
        self.assertEqual(spend_score(2, 4), 0)
    def test_damage(self):
        self.assertEqual(take_damage(4, 8), 0)
    def test_heal(self):
        self.assertEqual(heal(95, 20), 100)
    def test_unlock(self):
        self.assertTrue(unlocked(3, 3))
    def test_remaining(self):
        self.assertEqual(remaining(4, 6), 0)

if __name__ == "__main__":
    unittest.main()
`,
  };
  return {
    files,
    prompt:
      "Fix the six game-rule bugs in this small Python project. Run python3 -m unittest -v before and after the fixes. Keep the existing stage catalogs and public function signatures unchanged, make minimal edits to the existing modules, and report what passed. Do not rewrite the tests, install dependencies or use the network.",
  };
}
