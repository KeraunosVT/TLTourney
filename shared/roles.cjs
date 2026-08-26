// shared/roles.cjs — what you do in a fight, and where you stand in one.
//
// Read by both halves, like shared/classes.cjs: the form offers exactly these
// options and the validator accepts exactly these options, from one list. Two
// copies would drift, and the drift shows up as a signup the form let somebody
// file and the server then refused.
//
// These are tournament conventions rather than anything the game names, so
// unlike the class table they are typed out here rather than derived. Changing
// one is a migration, not just an edit — the CHECK constraints in
// migrations/002 name the same strings.

// What you play. ONE per signup, deliberately.
//
// A player with three classes may well cover two roles — a Templar healing and
// a Ravager on damage — but the question the draft actually asks is "what are
// you FOR", and a captain filling a healer slot wants the people who answer
// "healer", not everyone who could heal at a pinch. The second and third class
// slots already carry "I can be moved onto this".
const ROLES = ['Tank', 'DPS', 'Healer'];

// Where you stand in a large-scale fight. MANY per signup: these are genuinely
// not exclusive, and most people can take more than one.
const POSITIONS = ['Tank Party', 'Mainball Melee', 'Mainball Ranged', 'Killsquad'];

const isRole = (r) => ROLES.includes(r);
const isPosition = (p) => POSITIONS.includes(p);

module.exports = { ROLES, POSITIONS, isRole, isPosition };
