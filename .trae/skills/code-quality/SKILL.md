---
name: 'code-quality'
description: 'Ensure code quality, enforce coding standards, run linting and formatting, and perform code reviews. Invoke when user needs code quality checks, linting fixes, or code review.'
---

# Code Quality

This skill ensures code quality through linting, formatting, and code reviews.

## When to Use

- Before committing code
- After making changes
- Code review process
- Setting up quality standards
- Fixing linting errors
- Improving code maintainability

## Quality Checklist

### 1. Run Linting

```bash
# Run ESLint
npm run lint

# Fix linting issues automatically
npm run lint:fix

# Check specific file
npx eslint src/file.ts

# Check with specific rules
npx eslint src/ --rule 'no-console: error'
```

### 2. Format Code

```bash
# Format all files
npm run format

# Check formatting
npm run format:check

# Format specific file
npx prettier --write src/file.ts

# Format with specific options
npx prettier --write src/ --single-quote --trailing-comma es5
```

### 3. Type Checking

```bash
# Run TypeScript compiler
npm run build

# Check types without emitting
npx tsc --noEmit

# Check specific file
npx tsc --noEmit src/file.ts
```

### 4. Run Tests

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run specific test
npm test -- --testNamePattern="specific test"

# Run in watch mode
npm run test:watch
```

## Code Quality Standards

### TypeScript Best Practices

#### Use Explicit Types

```typescript
// Bad
const user = {
  name: 'John',
  age: 30,
};

// Good
interface User {
  name: string;
  age: number;
}

const user: User = {
  name: 'John',
  age: 30,
};
```

#### Avoid `any`

```typescript
// Bad
function processData(data: any) {
  return data.value;
}

// Good
interface Data {
  value: number;
}

function processData(data: Data): number {
  return data.value;
}

// Or use generics
function processData<T extends { value: number }>(data: T): number {
  return data.value;
}
```

#### Use Proper Async/Await

```typescript
// Bad
async function fetchData() {
  const response = fetch('/api/data');
  const data = response.json();
  return data;
}

// Good
async function fetchData(): Promise<Data> {
  const response = await fetch('/api/data');
  const data = await response.json();
  return data;
}
```

### React Best Practices

#### Use Functional Components

```typescript
// Bad (class component)
class MyComponent extends React.Component {
  render() {
    return <div>{this.props.value}</div>;
  }
}

// Good (functional component)
const MyComponent: React.FC<{ value: string }> = ({ value }) => {
  return <div>{value}</div>;
};
```

#### Use Hooks Properly

```typescript
// Bad: Hooks in wrong order
if (condition) {
  const [state, setState] = useState(0);
}

// Good: Hooks at top level
const [state, setState] = useState(0);

if (condition) {
  // Use state here
}
```

#### Memoize Expensive Computations

```typescript
// Bad
const MyComponent = ({ items }) => {
  const sorted = items.sort((a, b) => a.value - b.value);
  return <div>{sorted.map(item => <div key={item.id}>{item.name}</div>)}</div>;
};

// Good
const MyComponent = ({ items }) => {
  const sorted = useMemo(() =>
    [...items].sort((a, b) => a.value - b.value),
    [items]
  );

  return (
    <div>
      {sorted.map(item => <div key={item.id}>{item.name}</div>)}
    </div>
  );
};
```

### Backend Best Practices

#### Error Handling

```typescript
// Bad
app.get('/api/data', async (req, res) => {
  const data = await fetchData();
  res.json(data);
});

// Good
app.get('/api/data', async (req, res, next) => {
  try {
    const data = await fetchData();
    res.json(data);
  } catch (error) {
    next(error);
  }
});
```

#### Input Validation

```typescript
// Bad
app.post('/api/users', async (req, res) => {
  const { username, email } = req.body;
  // Directly use input without validation
});

// Good
import { body, validationResult } from 'express-validator';

app.post(
  '/api/users',
  [
    body('username').isLength({ min: 3 }).trim(),
    body('email').isEmail().normalizeEmail(),
  ],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    // Process validated input
  }
);
```

#### Security Best Practices

```typescript
// Bad: Direct SQL injection risk
const query = `SELECT * FROM users WHERE name = '${username}'`;

// Good: Use parameterized queries
const query = 'SELECT * FROM users WHERE name = ?';
const user = db.prepare(query).get(username);

// Bad: Expose sensitive data
res.json({ password: user.password });

// Good: Exclude sensitive data
const { password, ...safeUser } = user;
res.json(safeUser);
```

## Code Review Process

### 1. Self-Review Checklist

Before requesting review:

- [ ] Code follows project conventions
- [ ] No linting errors
- [ ] All tests pass
- [ ] New features have tests
- [ ] Code is well-documented
- [ ] No hardcoded values
- [ ] Error handling is proper
- [ ] Security best practices followed

### 2. Review Points

When reviewing code:

- **Functionality**: Does it work as intended?
- **Readability**: Is the code easy to understand?
- **Maintainability**: Can it be easily modified?
- **Performance**: Are there performance issues?
- **Security**: Are there security vulnerabilities?
- **Testing**: Is it adequately tested?
- **Documentation**: Is it well-documented?

### 3. Common Issues to Check

```typescript
// Check for:
// - Unused variables
// - Missing error handling
// - Inefficient algorithms
// - Duplicate code
// - Magic numbers
// - Inconsistent naming
// - Missing types
// - Unnecessary complexity
```

## Tools to Use

- **Read**: Read code to review
- **SearchCodebase**: Find similar patterns
- **Grep**: Search for code smells
- **RunCommand**: Run linting, tests
- **Write**: Fix code quality issues

## Best Practices

- Run linting before committing
- Format code consistently
- Write meaningful tests
- Document complex logic
- Follow naming conventions
- Keep functions small
- Avoid code duplication
- Use type safety
- Handle errors properly
- Review your own code first
