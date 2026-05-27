---
name: 'frontend-debug'
description: 'Debug React frontend issues, fix UI bugs, and resolve component problems. Invoke when user reports frontend bugs, UI issues, or React component errors.'
---

# Frontend Debug

This skill helps debug and fix React frontend issues.

## When to Use

- User reports UI bugs or visual issues
- React components not rendering correctly
- Frontend console errors
- State management problems
- Component lifecycle issues
- API integration issues in frontend
- Performance problems in React app

## Debugging Process

### 1. Identify the Issue

First, understand what the user is experiencing:

- What is the expected behavior?
- What is the actual behavior?
- When does the issue occur?
- Any error messages in console?

### 2. Check Console Errors

Always check browser console for errors:

```bash
# Open browser DevTools (F12) and check Console tab
# Look for:
# - JavaScript errors
# - React warnings
# - Network errors
```

### 3. Examine Component Code

Review the problematic component:

- Check props and state
- Verify useEffect dependencies
- Look for async operations
- Check event handlers

### 4. Test API Calls

If the issue involves API calls:

```bash
# Check Network tab in DevTools
# Verify:
# - Request URL and method
# - Request headers and body
# - Response status and data
```

### 5. Common Issues & Solutions

#### State Not Updating

```typescript
// Wrong
state.value = newValue;

// Correct
setState((prev) => ({ ...prev, value: newValue }));
```

#### useEffect Not Running

```typescript
// Check dependencies array
useEffect(() => {
  // effect
}, [dependency]); // Make sure all used variables are listed
```

#### Component Not Re-rendering

```typescript
// Use React.memo for optimization
const MyComponent = React.memo(({ prop }) => {
  // component
});
```

### 6. Performance Issues

- Use React DevTools Profiler
- Check for unnecessary re-renders
- Implement memoization (useMemo, useCallback)
- Virtualize long lists

### 7. Testing Fixes

After fixing the issue:

1. Test the specific scenario
2. Check for regression
3. Verify no console errors
4. Test on different browsers if needed

## Tools to Use

- **Read**: Read component files
- **SearchCodebase**: Find related components
- **Grep**: Search for error messages
- **RunCommand**: Start dev server, run tests

## Example Workflow

User: "The user list is not showing up"

1. Read the UserList component
2. Check console for errors
3. Verify API call is successful
4. Check if data is being set in state
5. Fix the issue (e.g., missing data mapping)
6. Test the fix

## Best Practices

- Always check console first
- Use React DevTools for debugging
- Test edge cases
- Document the fix
- Add tests if missing
