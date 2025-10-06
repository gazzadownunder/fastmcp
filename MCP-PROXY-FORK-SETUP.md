# Using Forked mcp-proxy with auth-issue Branch

## Current Status

The `package.json` is currently using the **standard version** temporarily:

```json
"mcp-proxy": "^5.8.0"  // Temporary - will change to fork once built
```

**Why?** The authentication fixes require **BOTH** FastMCP and mcp-proxy changes:
- ✅ FastMCP authentication fix is **complete** (in this repo)
- ⚠️ mcp-proxy authentication fix **requires the forked version**

## Test Results

With standard mcp-proxy@5.8.0:
- **72/77 tests pass** ✅
- **5/77 tests fail** ❌ (authentication error handling tests)

The failing tests are:
1. `stateless mode handles authentication function throwing errors`
2. `authentication failure handling: should throw error when auth.authenticated is false`
3. `authentication failure handling: should use default error message when auth.error is not provided`
4. `authentication failure handling: should handle authentication with custom error messages`
5. `authentication failure handling: should not create session for authenticated=false even with session data`

**Why they fail**: mcp-proxy@5.8.0 returns HTTP 500 for authentication errors instead of HTTP 401.

## Problem

The forked package **cannot be used yet** because:
1. The `auth-issue` branch does not have a built `dist/` folder
2. pnpm installs from GitHub but doesn't run build scripts
3. The package requires compiled JavaScript to work

Once your fork is built, **all 77 tests will pass**.

## Solution

You need to build and commit the `dist/` folder in your fork's `auth-issue` branch:

### Step 1: Clone and Build Your Fork

```bash
# Clone your fork
git clone https://github.com/gazzadownunder/mcp-proxy.git
cd mcp-proxy

# Switch to auth-issue branch
git checkout auth-issue

# Install dependencies
pnpm install

# Build the package
pnpm run build

# Verify dist folder was created
ls dist/
# Should show: index.js, index.d.ts, bin/, etc.
```

### Step 2: Commit the Built Files

```bash
# Add the dist folder
git add dist/

# Commit
git commit -m "chore: add built dist folder for npm installation"

# Push to GitHub
git push origin auth-issue
```

### Step 3: Update This Package

```bash
# Back in the fastmcp directory
cd "c:\Users\gazza\Local Documents\GitHub\MCP Services\fastmcp"

# Remove old installation
rm -rf node_modules/.pnpm/mcp-proxy@*
rm pnpm-lock.yaml

# Reinstall with fresh built package
pnpm install

# Run tests
pnpm test
```

## Alternative: Use pnpm Patch

If you don't want to commit `dist/` to git, you can use pnpm's patch feature:

```bash
# Create a patch
pnpm patch mcp-proxy@5.8.0

# This will extract the package to a temp directory
# Apply your changes from the fork manually
# Then commit the patch:
pnpm patch-commit <path-shown-by-previous-command>
```

## Temporary Workaround

For now, the package.json still references the forked repo, but **tests will fail** until you build and commit the dist folder.

To temporarily revert to the working version:

```json
"mcp-proxy": "^5.8.0"
```

Then run:
```bash
pnpm install
```

## Current Package.json

```json
{
  "dependencies": {
    "mcp-proxy": "git+https://github.com/gazzadownunder/mcp-proxy.git#auth-issue"
  }
}
```

## Testing

After building and pushing the dist folder, verify it works:

```bash
# Should pass all tests
pnpm test

# Check mcp-proxy version
pnpm list mcp-proxy
# Should show: mcp-proxy 1.0.0 (from your fork)
```

## Notes

- The authentication fixes in this repo (FastMCP.ts) are **complete and tested**
- The mcp-proxy fork needs its `dist/` folder built and committed
- Once both are ready, all 77 tests should pass
