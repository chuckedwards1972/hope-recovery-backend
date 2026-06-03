const fs = require('fs');
const path = require('path');

const f = path.join(__dirname, 'src', 'routes', 'auth.ts');
let s = fs.readFileSync(f, 'utf8');

if (s.includes("router.post('/',")) {
  console.log('Already patched');
  process.exit(0);
}

const patch = `
router.post('/', async (req: any, res: any, next: any) => {
  try {
    const { username, email, password } = req.body;
    const identifier = username || email;
    if (!identifier || !password) return res.status(400).json({ error: 'Username and password required' });
    const user = await prisma.user.findFirst({
      where: { OR: [{ email: identifier }, { email: { contains: identifier } }] }
    });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, (user as any).passwordHash || (user as any).password || '');
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    const token = signAccessToken({ userId: user.id, role: (user as any).role || 'member' });
    const refreshToken = signRefreshToken({ userId: user.id });
    res.json({
      token, refreshToken,
      user: { id: user.id, email: user.email, name: (user as any).name || user.email, role: (user as any).role || 'member', level: (user as any).level || 0, campus: (user as any).campus || 'All' }
    });
  } catch (e) { next(e); }
});
`;

s = s.replace('const router = Router();', 'const router = Router();\n' + patch);
fs.writeFileSync(f, s, 'utf8');
console.log('Auth POST / patched successfully');
