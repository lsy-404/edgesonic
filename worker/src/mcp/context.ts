import type { User } from "../types/entities";

export interface McpPrincipal {
  user: User;
  scopes: string[];
  grantId?: string;
}

const MCP_PRINCIPAL = Symbol("edgesonic.mcpPrincipal");

export function withMcpPrincipal<E extends object>(env: E, principal: McpPrincipal): E {
  return { ...env, [MCP_PRINCIPAL]: principal };
}

export function mcpPrincipal(env: object): McpPrincipal | undefined {
  return (env as { [MCP_PRINCIPAL]?: McpPrincipal })[MCP_PRINCIPAL];
}
