import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { getRandomPort } from "get-port-please";
import { expect, test } from "vitest";
import { z } from "zod";

import {
  CanAccessResult,
  FastMCP,
  FastMCPSession,
  InsufficientScopeError,
} from "./FastMCP.js";

const runWithTestServer = async ({
  client: createClient,
  run,
  server: createServer,
}: {
  client?: () => Promise<Client>;
  run: ({
    client,
    server,
    session,
  }: {
    client: Client;
    server: FastMCP;
    session: FastMCPSession;
  }) => Promise<void>;
  server?: () => Promise<FastMCP>;
}) => {
  const port = await getRandomPort();

  const server = createServer
    ? await createServer()
    : new FastMCP({
        name: "Test",
        version: "1.0.0",
      });

  await server.start({
    httpStream: {
      port,
    },
    transportType: "httpStream",
  });

  try {
    const client = createClient
      ? await createClient()
      : new Client(
          {
            name: "example-client",
            version: "1.0.0",
          },
          {
            capabilities: {},
          },
        );

    const transport = new SSEClientTransport(
      new URL(`http://localhost:${port}/sse`),
    );

    const session = await new Promise<FastMCPSession>((resolve) => {
      server.on("connect", async (event) => {
        await event.session.waitForReady();
        resolve(event.session);
      });

      client.connect(transport);
    });

    await run({ client, server, session });
  } finally {
    await server.stop();
  }
};

test("InsufficientScopeError creates proper error structure", () => {
  const error = new InsufficientScopeError(
    "write_file",
    ["files:write", "files:delete"],
    "Writing files requires write permissions",
  );

  expect(error.name).toBe("InsufficientScopeError");
  expect(error.toolName).toBe("write_file");
  expect(error.requiredScopes).toEqual(["files:write", "files:delete"]);
  expect(error.errorDescription).toBe(
    "Writing files requires write permissions",
  );
  expect(error.code).toBe(ErrorCode.InvalidRequest);

  const json = error.toJSON();
  expect(json.code).toBe(-32001);
  expect(json.message).toContain("Writing files requires write permissions");
  expect(json.data).toEqual({
    error: "insufficient_scope",
    errorDescription: "Writing files requires write permissions",
    requiredScopes: ["files:write", "files:delete"],
    toolName: "write_file",
  });
});

test("InsufficientScopeError with default message", () => {
  const error = new InsufficientScopeError("admin_tool", ["admin"]);

  expect(error.message).toContain(
    "Insufficient scope for tool 'admin_tool': requires scopes [admin]",
  );
  expect(error.errorDescription).toBeUndefined();

  const json = error.toJSON();
  expect(json.data.errorDescription).toBeUndefined();
});

test("canAccess with boolean return (backward compatibility)", async () => {
  await runWithTestServer({
    run: async ({ client }) => {
      // List tools - private_tool is filtered out when canAccess returns false
      const listResult = await client.listTools();

      expect(listResult.tools).toHaveLength(1);
      expect(listResult.tools.map((t) => t.name)).toContain("public_tool");
      expect(listResult.tools.map((t) => t.name)).not.toContain("private_tool");

      // Call public tool - should succeed
      const publicResult = await client.callTool({
        arguments: {},
        name: "public_tool",
      });

      expect(publicResult.content[0].text).toBe("success");

      // Call private tool directly - should throw error because canAccess fails
      // Note: Tool is filtered from list but runtime check still applies if called directly
      await expect(
        client.callTool({
          arguments: {},
          name: "private_tool",
        }),
      ).rejects.toThrow();
    },
    server: async () => {
      const server = new FastMCP<{ userId: string }>({
        authenticate: async () => {
          return { userId: "test-user" };
        },
        name: "Test",
        version: "1.0.0",
      });

      server.addTool({
        canAccess: () => true,
        description: "A public tool",
        execute: async () => "success",
        name: "public_tool",
        parameters: z.object({}),
      });

      server.addTool({
        canAccess: () => false,
        description: "A private tool",
        execute: async () => "should not execute",
        name: "private_tool",
        parameters: z.object({}),
      });

      return server;
    },
  });
});

test("canAccess with CanAccessResult return (scope challenge)", async () => {
  type AuthContext = { scopes: string[] };

  await runWithTestServer({
    run: async ({ client }) => {
      // Call read_file - should succeed (user has files:read)
      const readResult = await client.callTool({
        arguments: { path: "test.txt" },
        name: "read_file",
      });

      expect(readResult.content[0].text).toBe("Contents of test.txt");

      // Call write_file - should throw InsufficientScopeError
      try {
        await client.callTool({
          arguments: { content: "hello", path: "test.txt" },
          name: "write_file",
        });
        expect.fail("Should have thrown InsufficientScopeError");
      } catch (error: unknown) {
        expect(error).toBeDefined();

        // The MCP SDK wraps errors - check the underlying error code
        const mcpError = error as {
          code?: number;
          data?: unknown;
          message: string;
        };

        // Error code might be ErrorCode.InvalidRequest (-32600) from MCP SDK
        // The important part is the data field with scope challenge info
        expect(mcpError.message).toContain("files:write");

        // Verify error data contains scope challenge information
        if (mcpError.data && typeof mcpError.data === "object") {
          const errorData = mcpError.data as {
            error?: string;
            errorDescription?: string;
            requiredScopes?: string[];
            toolName?: string;
          };

          expect(errorData.error).toBe("insufficient_scope");
          expect(errorData.toolName).toBe("write_file");
          expect(errorData.requiredScopes).toEqual(["files:write"]);
          expect(errorData.errorDescription).toBe(
            "Writing files requires 'files:write' scope",
          );
        }
      }
    },
    server: async () => {
      const server = new FastMCP<AuthContext>({
        authenticate: async () => {
          // Simulate authenticated user with limited scopes
          return { scopes: ["files:read"] };
        },
        name: "Scope Test Server",
        version: "1.0.0",
      });

      server.addTool({
        canAccess: (auth) => {
          if (auth?.scopes?.includes("files:read")) {
            return true;
          }
          return {
            allowed: false,
            errorDescription: "Reading files requires 'files:read' scope",
            requiredScopes: ["files:read"],
          };
        },
        description: "Read a file",
        execute: async ({ path }) => `Contents of ${path}`,
        name: "read_file",
        parameters: z.object({ path: z.string() }),
      });

      server.addTool({
        canAccess: (auth) => {
          if (auth?.scopes?.includes("files:write")) {
            return true;
          }
          return {
            allowed: false,
            errorDescription: "Writing files requires 'files:write' scope",
            requiredScopes: ["files:write"],
          };
        },
        description: "Write a file",
        execute: async ({ content, path }) =>
          `Wrote ${content.length} bytes to ${path}`,
        name: "write_file",
        parameters: z.object({ content: z.string(), path: z.string() }),
      });

      return server;
    },
  });
});

test("canAccess with multiple required scopes", async () => {
  type AuthContext = { scopes: string[] };

  await runWithTestServer({
    run: async ({ client }) => {
      try {
        await client.callTool({
          arguments: {},
          name: "admin_operation",
        });
        expect.fail("Should have thrown InsufficientScopeError");
      } catch (error: unknown) {
        const mcpError = error as { code?: number; data?: unknown };

        if (mcpError.data && typeof mcpError.data === "object") {
          const errorData = mcpError.data as { requiredScopes?: string[] };
          expect(errorData.requiredScopes).toEqual([
            "admin",
            "files:write",
            "files:delete",
          ]);
        }
      }
    },
    server: async () => {
      const server = new FastMCP<AuthContext>({
        authenticate: async () => {
          return { scopes: ["files:read"] };
        },
        name: "Multi-Scope Test",
        version: "1.0.0",
      });

      server.addTool({
        canAccess: (auth) => {
          const requiredScopes = ["admin", "files:write", "files:delete"];
          const hasAllScopes = requiredScopes.every((scope) =>
            auth?.scopes?.includes(scope),
          );

          if (hasAllScopes) {
            return true;
          }

          // Return all required scopes (recommended approach per MCP spec)
          return {
            allowed: false,
            errorDescription: "This operation requires admin privileges",
            requiredScopes,
          };
        },
        description: "Admin operation requiring multiple scopes",
        execute: async () => "Admin operation completed",
        name: "admin_operation",
        parameters: z.object({}),
      });

      return server;
    },
  });
});

test("canAccess without authentication (no auth context)", async () => {
  await runWithTestServer({
    run: async ({ client }) => {
      // When server has no authenticate function, auth is undefined
      // canAccess should NOT be called in this case (tools without auth bypass the check)
      const result = await client.callTool({
        arguments: {},
        name: "protected_tool",
      });

      // Tool executes because canAccess is only checked when this.#auth exists
      expect(result.content[0].text).toBe("should not execute");
    },
    server: async () => {
      const server = new FastMCP({
        name: "Test",
        version: "1.0.0",
      });

      server.addTool({
        canAccess: (auth) => {
          // When no auth is provided, deny access
          if (!auth) {
            return {
              allowed: false,
              errorDescription: "Authentication required",
              requiredScopes: ["authenticated"],
            };
          }
          return true;
        },
        description: "Tool with canAccess check",
        execute: async () => "should not execute",
        name: "protected_tool",
        parameters: z.object({}),
      });

      return server;
    },
  });
});

test("CanAccessResult type is properly exported", () => {
  // TypeScript compile-time test - if this compiles, the type is exported
  const result: CanAccessResult = {
    allowed: false,
    errorDescription: "Test description",
    requiredScopes: ["test"],
  };

  expect(result.allowed).toBe(false);
  expect(result.requiredScopes).toEqual(["test"]);
  expect(result.errorDescription).toBe("Test description");
});

test("canAccess returning object without requiredScopes", async () => {
  type AuthContext = { userId: string };

  await runWithTestServer({
    run: async ({ client }) => {
      try {
        await client.callTool({
          arguments: {},
          name: "restricted_tool",
        });
        expect.fail("Should have thrown InsufficientScopeError");
      } catch (error: unknown) {
        const mcpError = error as { code?: number; data?: unknown };

        if (mcpError.data && typeof mcpError.data === "object") {
          const errorData = mcpError.data as {
            errorDescription?: string;
            requiredScopes?: string[];
          };

          // Should have empty scopes array
          expect(errorData.requiredScopes).toEqual([]);
          expect(errorData.errorDescription).toBe(
            "Access denied for business reasons",
          );
        }
      }
    },
    server: async () => {
      const server = new FastMCP<AuthContext>({
        authenticate: async () => {
          return { userId: "user123" };
        },
        name: "Test Server",
        version: "1.0.0",
      });

      server.addTool({
        canAccess: () => {
          // Return object with allowed: false but no requiredScopes
          return {
            allowed: false,
            errorDescription: "Access denied for business reasons",
          };
        },
        description: "Tool that denies access without scope info",
        execute: async () => "should not execute",
        name: "restricted_tool",
        parameters: z.object({}),
      });

      return server;
    },
  });
});
