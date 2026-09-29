import { bodyField } from './common.js';
import type { LanguageSpec } from './types.js';

const WITH_BODY = ['function_definition', 'modifier_definition', 'constructor_definition', 'fallback_receive_definition'];

/**
 * Solidity: bodies of functions, modifiers, constructors and `receive`/`fallback` become
 * `{ /* ... *\/ }`. Contracts, interfaces, libraries, state variables, events, errors,
 * structs, enums, modifiers' signatures and NatSpec comments are kept.
 */
export const solidity: LanguageSpec = {
  id: 'solidity',
  fence: 'solidity',
  grammar: 'tree-sitter-solidity',
  extensions: ['.sol'],
  // Empty bodies (`receive() external payable {}`) are already as small as they get.
  bodyReplacement: (node, placeholder) => (node.childForFieldName('body')?.namedChildCount ? bodyField(node, placeholder) : null),
  candidates: WITH_BODY,
  outline: {
    containers: ['contract_declaration', 'interface_declaration', 'library_declaration'],
    members: [...WITH_BODY, 'event_definition', 'error_declaration', 'state_variable_declaration'],
    declarations: ['struct_declaration', 'enum_declaration', 'user_defined_type_definition'],
  },
};
