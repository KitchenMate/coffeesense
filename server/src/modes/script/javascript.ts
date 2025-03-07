import { LanguageModelCache, getLanguageModelCache } from '../../embeddedSupport/languageModelCache';
import {
  SymbolInformation,
  CompletionItem,
  Location,
  SignatureHelp,
  SignatureInformation,
  ParameterInformation,
  Definition,
  TextEdit,
  Diagnostic,
  DiagnosticSeverity,
  Range,
  CompletionItemKind,
  Hover,
  MarkedString,
  DocumentHighlight,
  DocumentHighlightKind,
  CompletionList,
  Position,
  DiagnosticTag,
  MarkupContent,
  CodeAction,
  CodeActionKind,
  CompletionItemTag,
  CodeActionContext
} from 'vscode-languageserver-types';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { LanguageMode } from '../../embeddedSupport/languageModes';
import { CoffeescriptDocumentRegions, LanguageRange, LanguageId } from '../../embeddedSupport/embeddedSupport';
import { getFileFsPath, getFilePath } from '../../utils/paths';

import { URI } from 'vscode-uri';
import type ts from 'typescript';

import { NULL_SIGNATURE } from '../nullMode';
import { DependencyService, RuntimeLibrary } from '../../services/dependencyService';
import { CodeActionData, CodeActionDataKind, OrganizeImportsActionData } from '../../types';
import { IServiceHost } from '../../services/typescriptService/serviceHost';
import { toCompletionItemKind, toSymbolKind } from '../../services/typescriptService/util';
import * as Previewer from './previewer';
import { isVCancellationRequested, VCancellationToken } from '../../utils/cancellationToken';
import { EnvironmentService } from '../../services/EnvironmentService';
import { FILE_EXTENSION, FILE_EXTENSION2, LANGUAGE_ID } from '../../language';
import transpile_service, { common_js_variable_name_character, get_word_around_position } from '../../services/transpileService';
import { LineMap } from 'coffeescript';

export async function getJavascriptMode(
  tsModule: RuntimeLibrary['typescript'],
  serviceHost: IServiceHost,
  env: EnvironmentService,
  documentRegions: LanguageModelCache<CoffeescriptDocumentRegions>,
  dependencyService: DependencyService
): Promise<LanguageMode> {
  const jsDocuments = getLanguageModelCache(10, 60, document => {
    const coffeescriptDocument = documentRegions.refreshAndGet(document);
    return coffeescriptDocument.getSingleTypeDocument('script');
  });

  const { updateCurrentCoffeescriptTextDocument } = serviceHost;
  let supportedCodeFixCodes: Set<number>;

  function getUserPreferences(scriptDoc: TextDocument): ts.UserPreferences {
    return getUserPreferencesByLanguageId(scriptDoc.languageId);
  }
  function getUserPreferencesByLanguageId(languageId: string): ts.UserPreferences {
    const baseConfig = env.getConfig()[languageId === 'javascript' ? 'javascript' : 'typescript'];
    const preferencesConfig = baseConfig?.preferences;

    if (!baseConfig || !preferencesConfig) {
      return {};
    }

    function safeGetConfigValue<V extends string | boolean, A extends Array<V>, D = undefined>(
      configValue: any,
      allowValues: A,
      defaultValue?: D
    ) {
      return allowValues.includes(configValue) ? (configValue as A[number]) : (defaultValue as D);
    }

    return {
      quotePreference: 'auto',
      importModuleSpecifierPreference: safeGetConfigValue(preferencesConfig.importModuleSpecifier, [
        'relative',
        'non-relative'
      ]),
      importModuleSpecifierEnding: safeGetConfigValue(
        preferencesConfig.importModuleSpecifierEnding,
        ['minimal', 'index', 'js'],
        'auto'
      ),
      allowTextChangesInNewFiles: true,
      providePrefixAndSuffixTextForRename:
        preferencesConfig.renameShorthandProperties === false ? false : preferencesConfig.useAliasesForRenames,
      // @ts-expect-error
      allowRenameOfImportPath: true,
      includeAutomaticOptionalChainCompletions: baseConfig.suggest.includeAutomaticOptionalChainCompletions ?? true,
      provideRefactorNotApplicableReason: true
    };
  }

  return {
    getId() {
      return 'javascript';
    },
    async doValidation(coffee_doc: TextDocument, cancellationToken?: VCancellationToken): Promise<Diagnostic[]> {
      if (await isVCancellationRequested(cancellationToken)) {
        return [];
      }
      const { scriptDoc: js_doc, service } = updateCurrentCoffeescriptTextDocument(coffee_doc);
      if (!languageServiceIncludesFile(service, coffee_doc.uri)) {
        return [];
      }

      if (await isVCancellationRequested(cancellationToken)) {
        return [];
      }

      const transpilation = transpile_service.result_by_uri.get(coffee_doc.uri)
      if(!transpilation)
        return []
      if(transpilation.diagnostics)
        return transpilation.diagnostics || []

      const fileFsPath = getFileFsPath(coffee_doc.uri);
      const program = service.getProgram();
      const sourceFile = program?.getSourceFile(fileFsPath);
      if (!program || !sourceFile) {
        return [];
      }

      let rawScriptDiagnostics = [
        ...program.getSyntacticDiagnostics(sourceFile, cancellationToken?.tsToken),
        ...program.getSemanticDiagnostics(sourceFile, cancellationToken?.tsToken),
        ...service.getSuggestionDiagnostics(fileFsPath)
      ];

      const compilerOptions = program.getCompilerOptions();
      if (compilerOptions.declaration || compilerOptions.composite) {
        rawScriptDiagnostics = [
          ...rawScriptDiagnostics,
          ...program.getDeclarationDiagnostics(sourceFile, cancellationToken?.tsToken)
        ];
      }

      const js_text = js_doc.getText()

      return rawScriptDiagnostics
      .filter(diag => !env.getConfig().coffeesense.ignoredTypescriptErrorCodes.includes(diag.code))
      .filter(diag => diag.messageText !== "Parameter '_' implicitly has an 'any' type." &&
        diag.messageText !== "'_' is declared but its value is never read.")
      .map(diag => {
        const tags: DiagnosticTag[] = [];
        let message = tsModule.flattenDiagnosticMessageText(diag.messageText, '\n')

        if (diag.reportsUnnecessary) {
          tags.push(DiagnosticTag.Unnecessary);
        }
        if (diag.reportsDeprecated) {
          tags.push(DiagnosticTag.Deprecated);
        }

        let range = convertRange(js_doc, diag as ts.TextSpan)

        if(js_text.slice(js_doc.offsetAt({ line: range.start.line, character: 0 }))
          .match(/^\s*var /)) {
            // Position of errors shown at variable declaration are most often useless, it would
            // be better to show them at their (first) usage instead which implies declaration
            // in CS. Luckily, this is possible using highlight querying:
            const occurrence = service.getOccurrencesAtPosition(fileFsPath, js_doc.offsetAt(range.start))?.[1]
            if(occurrence)
              range = convertRange(js_doc, occurrence.textSpan)
        }

        if(transpilation.source_map) {
          const coffee_range = transpile_service.range_js_to_coffee(transpilation.source_map, range)
          if(coffee_range) {
            range = coffee_range
          } else {
            message += `\n\nThe position of this error could not be mapped back to CoffeeScript, sorry. Here's the failing JavaScript context:\n\n${js_text.slice(
                js_doc.offsetAt({ line: range.start.line - 2, character: 0}),
                js_doc.offsetAt({ line: range.start.line + 2, character: Number.MAX_VALUE}))}`
            range = Range.create(0, 0, 0, 0)
          }
          if(range.end.line < range.start.line || range.end.line === range.start.line && range.end.character < range.start.character)
            // end character is messed up (happens often). just use whole word instead
            // Setting char end to start or to start+1 only highlights the first character.
            // No idea how to properly highlight the full next word? Doing it the manual way:
            range.end = { line: range.start.line, character: range.start.character + 1 }
            while(coffee_doc.getText(Range.create(range.end, { line: range.end.line, character: range.end.character + 1}))
                .match(common_js_variable_name_character)) {
              range.end.character++;
            }
        }

        // syntactic/semantic diagnostic always has start and length
        // so we can safely cast diag to TextSpan
        return <Diagnostic>{
          range,
          severity: convertTSDiagnosticCategoryToDiagnosticSeverity(tsModule, diag.category),
          message,
          tags,
          code: diag.code,
          source: 'CoffeeSense [TS]'
        };
      });
    },
    doComplete(coffee_doc: TextDocument, coffee_position: Position): CompletionList {
      const { scriptDoc: js_doc, service } = updateCurrentCoffeescriptTextDocument(coffee_doc);
      if (!languageServiceIncludesFile(service, coffee_doc.uri)) {
        return { isIncomplete: false, items: [] };
      }
      const fileFsPath = getFileFsPath(coffee_doc.uri);

      const transpilation = transpile_service.result_by_uri.get(coffee_doc.uri)
      if(!transpilation)
        return { isIncomplete: false, items: [] }
      
      const coffee_text = coffee_doc.getText()
      const coffee_last_char = coffee_text[coffee_doc.offsetAt(coffee_position) - 1]
      let position: Position
      if(transpilation.source_map) {
        // For position reverse mapping, remove . char, and add again to result afterwards.
        // Otherwise, the source map does not know what you're talking of
        const coffee_position_excl_trigger_char = {
          line: coffee_position.line,
          character: coffee_position.character - (coffee_last_char==='.'? 1 : 0)
        }
        let js_position = transpile_service.position_coffee_to_js(transpilation, coffee_position_excl_trigger_char, coffee_doc)
        if(!js_position) {
          // The following works great in principle, but is not useful as cs indentation is wrong,
          // comma is missing, scope is mostly simply wrong
          /*
          // Fallback: Current line in coffee does not exist in JS, e.g. empty line, perhaps
          // indented. In this case, find the next previous mapping-existing line and move cursor forward
          // one character/line.
          const i_coffee_pos = { character: 0, line: coffee_position_excl_trigger_char.line }
          while(--i_coffee_pos.line > 0) {
            js_position = transpile_service.position_coffee_to_js(transpilation, i_coffee_pos, coffee_doc)
            if(js_position)
              break
          }
          if(js_position) {
            js_position.line++
            js_position.character = 0
          }
          */
        }
        if(!js_position)
          return { isIncomplete: false, items: [] }
        position = {
          line: js_position.line,
          character: js_position.character + (coffee_last_char==='.'? 1 : 0)
        }
      } else {
        // If no source map, the file is passed as coffee text which must not be mapped
        position = coffee_position
      }

      let js_offset = js_doc.offsetAt(position);
      if(position.character > 1000) // End of line (Number.MAX_VALUE)
        js_offset--
        
      let char_offset = 0
      const js_text = js_doc.getText()
      const js_last_char = js_text[js_offset - 1]
      const js_next_char = js_text[js_offset]
      // When CS cursor is e.g. at `a('|')`, completion does not work bc of bad source mapping,
      // JS cursor is falsely `a(|'')`. Circumvent this:
      const special_trigger_chars = ['"', "'"]
      for(const s of special_trigger_chars) {
        if(coffee_last_char === s && js_last_char !== s && js_next_char === s) {
          char_offset += 1
          break
        }
      }
      js_offset += char_offset

      if(char_offset === 0) {
        if(js_text.substr(js_offset, 14) === 'this.valueOf()') {
          // CS cursor: `...@|`
          js_offset += 'this.'.length
        } else if(transpilation.fake_line !== undefined) {
          const coffee_line_until_cursor = coffee_text.slice(coffee_doc.offsetAt({ line:coffee_position.line, character:0 }), coffee_doc.offsetAt(coffee_position))
          // CS cursor can be everything, but in case it is at `...@a.|` or `...@a b|`,
          // the `@`s to `this` conversions need to be considered because fake lines are
          // CS only.
          // Edge case error: current_line != fake_line (so current_line is JS) and
          // current_line.includes('@'), but let's ignore that
          js_offset += (coffee_line_until_cursor.split('@').length - 1) * ('this.'.length - '@'.length)
        }
      }
      
      const completions = service.getCompletionsAtPosition(fileFsPath, js_offset, {
        ...getUserPreferences(js_doc),
        triggerCharacter: getTsTriggerCharacter(coffee_last_char || ''),
        includeCompletionsWithInsertText: true,
        includeCompletionsForModuleExports: true
      });

      if (!completions) {
        return { isIncomplete: false, items: [] };
      }
      return {
        isIncomplete: false,
        items: completions.entries.map((entry, index) => {
          let range = entry.replacementSpan && convertRange(js_doc, entry.replacementSpan);
          if(range) {
            if(transpilation.source_map)
              range = transpile_service.range_js_to_coffee(transpilation.source_map, range)  || range
            range.start.character += char_offset
            range.end.character += char_offset
            // Or maybe do not calculate range at all, just set to coffee_position + entry length? Should work too
          }
          
          const { label, detail } = calculateLabelAndDetailTextForPathImport(entry);

          const item: CompletionItem = {
            uri: coffee_doc.uri,
            position,
            preselect: entry.isRecommended ? true : undefined,
            label,
            detail,
            filterText: getFilterText(entry.insertText),
            sortText: entry.sortText + index,
            kind: toCompletionItemKind(entry.kind),
            textEdit: range && TextEdit.replace(range, entry.insertText || entry.name),
            insertText: entry.insertText,
            data: {
              // data used for resolving item details (see 'doResolve')
              languageId: js_doc.languageId,
              uri: coffee_doc.uri,
              offset: js_offset,
              source: entry.source,
              tsData: entry.data
            }
          } as CompletionItem;
          // fix: Missing vue extension in filename with import autocomplete
          // https://github.com/vuejs/vetur/issues/2908
          if (item.kind === CompletionItemKind.File && !item.detail?.endsWith('.js') && !item.detail?.endsWith('.ts')) {
            item.insertText = item.detail;
          }
          if (entry.kindModifiers) {
            const kindModifiers = parseKindModifier(entry.kindModifiers ?? '');
            if (kindModifiers.optional) {
              if (!item.insertText) {
                item.insertText = item.label;
              }
              if (!item.filterText) {
                item.filterText = item.label;
              }
              item.label += '?';
            }
            if (kindModifiers.deprecated) {
              item.tags = [CompletionItemTag.Deprecated];
            }
            if (kindModifiers.color) {
              item.kind = CompletionItemKind.Color;
            }
          }

          return item;
        })
      };

      function calculateLabelAndDetailTextForPathImport(entry: ts.CompletionEntry) {
        // Is import path completion
        if (entry.kind === tsModule.ScriptElementKind.scriptElement) {
          if (entry.kindModifiers) {
            return {
              label: entry.name,
              detail: entry.name + entry.kindModifiers
            };
          } else {
            if (entry.name.endsWith(`.${FILE_EXTENSION}`)) {
              return {
                label: entry.name.slice(0, -`.${FILE_EXTENSION}`.length),
                detail: entry.name
              };
            } else if (entry.name.endsWith(`.${FILE_EXTENSION2}`)) {
              return {
                label: entry.name.slice(0, -`.${FILE_EXTENSION2}`.length),
                detail: entry.name
              };
            }
          }
        }

        return {
          label: entry.name,
          detail: undefined
        };
      }
    },
    doResolve(coffee_doc: TextDocument, item: CompletionItem): CompletionItem {
      const { scriptDoc: js_doc, service } = updateCurrentCoffeescriptTextDocument(coffee_doc);
      if (!languageServiceIncludesFile(service, coffee_doc.uri)) {
        return item;
      }
      const fileFsPath = getFileFsPath(coffee_doc.uri);

      const transpilation = transpile_service.result_by_uri.get(coffee_doc.uri)
      if(!transpilation)
        return item

      const details = service.getCompletionEntryDetails(
        fileFsPath,
        item.data.offset,
        item.label,
        {},
        item.data.source,
        getUserPreferences(js_doc),
        item.data.tsData
      );

      if (details && item.kind !== CompletionItemKind.File && item.kind !== CompletionItemKind.Folder) {
        item.detail = Previewer.plain(tsModule.displayPartsToString(details.displayParts));
        const documentation: MarkupContent = {
          kind: 'markdown',
          value: tsModule.displayPartsToString(details.documentation) + '\n\n'
        };

        if (details.tags) {
          if (details.tags) {
            details.tags.forEach(x => {
              const tagDoc = Previewer.getTagDocumentation(x);
              if (tagDoc) {
                documentation.value += tagDoc + '\n\n';
              }
            });
          }
        }

        if (details.codeActions) {
          // auto imports
          const textEdits = details.codeActions.map(action =>
            action.changes.map(change =>
              change.textChanges.map(text_change => {
                let range
                if(transpilation.source_map) {
                  range = convertRange(js_doc, text_change.span)
                  const js_range = range
                  let coffee_range = transpile_service.range_js_to_coffee(transpilation.source_map, js_range)
                  if(coffee_range) {
                    const coffee_line = coffee_doc.getText().split('\n')[coffee_range.start.line]!
                    let coffee_range_end_of_named_group
                    let coffee_end_of_named_group_col = coffee_line.indexOf('}')
                    if(coffee_end_of_named_group_col > -1) {
                      if(coffee_line[coffee_end_of_named_group_col - 1] === ' ')
                        coffee_end_of_named_group_col--
                      const coffee_pos = { line: coffee_range.start.line, character: coffee_end_of_named_group_col }
                      coffee_range_end_of_named_group = Range.create(coffee_pos, coffee_pos)
                    }
                    if(text_change.newText.startsWith(', { ')) {
                      // Add new named imports group to existing default import
                      const coffee_from_col = coffee_line.indexOf(' from ')
                      if(coffee_from_col > -1) {
                        const coffee_pos = { line: coffee_range.start.line, character: coffee_from_col }
                        coffee_range = Range.create(coffee_pos, coffee_pos)
                      }
                    } else if(text_change.newText.startsWith(', ')) {
                      // Add named import to existing named imports group
                      coffee_range = coffee_range_end_of_named_group
                    } else if(text_change.newText[0] === '\n') {                      
                      // Add named import to existing named imports group in new line
                      // We don't want new line and add a missing comma
                        text_change.newText = text_change.newText.replace(/^\s+(.+)$/, (_, named_import) =>
                          ', ' + named_import)
                        coffee_range = coffee_range_end_of_named_group
                    } else if(text_change.newText === ',') {
                      // named import to existing named imports group actions consist of two text changes,
                      // the first one being a comma, ignore it
                      text_change.newText = ''
                    } else if(text_change.newText.trim().endsWith(',')) {
                      // Add named import to existing named imports group, possibly new line,
                      // in between two other named imports
                      // We don't insert in between but only at the end of group instead
                      text_change.newText = ', ' + text_change.newText.trim().slice(0, -1)
                      coffee_range = coffee_range_end_of_named_group
                    } else {
                      // Add entirely new import. Line should start with 'import',
                      // but it can also be CommonJS-style, I haven't checked this further
                      const coffee_pos = { line: 0, character: 0 }
                      coffee_range = Range.create(coffee_pos, coffee_pos)
                    }
                  }
                  range = coffee_range
                }
                if(!range)
                  range = Range.create(0, 0, 0, 0)
                return {
                  range,
                  newText: text_change.newText.replace(/;/g,'')
                }
          }))).flat().flat()

          item.additionalTextEdits = textEdits;

          details.codeActions.forEach(action => {
            if (action.description) {
              documentation.value += '\n' + action.description;
            }
          });
        }
        item.documentation = documentation;
        delete item.data;
      }
      return item;
    },
    doHover(doc: TextDocument, position: Position): Hover {
      const { scriptDoc, service } = updateCurrentCoffeescriptTextDocument(doc);
      if (!languageServiceIncludesFile(service, doc.uri)) {
        return { contents: [] };
      }
      const fileFsPath = getFileFsPath(doc.uri);

      const transpilation = transpile_service.result_by_uri.get(doc.uri)
      if(!transpilation)
        return { contents: [] }

      if(transpilation.source_map)
        position = transpile_service.position_coffee_to_js(transpilation, position, doc) || position

      const info = service.getQuickInfoAtPosition(fileFsPath, scriptDoc.offsetAt(position));

      if (info) {
        const display = tsModule.displayPartsToString(info.displayParts);
        const markedContents: MarkedString[] = [{ language: 'ts', value: display }];

        let hoverMdDoc = '';
        const doc = Previewer.plain(tsModule.displayPartsToString(info.documentation));
        if (doc) {
          hoverMdDoc += doc + '\n\n';
        }

        if (info.tags) {
          info.tags.forEach(x => {
            const tagDoc = Previewer.getTagDocumentation(x);
            if (tagDoc) {
              hoverMdDoc += tagDoc + '\n\n';
            }
          });
        }

        if (hoverMdDoc.trim() !== '') {
          markedContents.push(hoverMdDoc);
        }

        let range = convertRange(scriptDoc, info.textSpan)
        if(transpilation.source_map)
          range = transpile_service.range_js_to_coffee(transpilation.source_map, range) || range

        return {
          range,
          contents: markedContents
        };
      }
      return { contents: [] };
    },
    doSignatureHelp(coffee_doc: TextDocument, position: Position): SignatureHelp | null {
      const { scriptDoc: js_doc, service } = updateCurrentCoffeescriptTextDocument(coffee_doc);
      if (!languageServiceIncludesFile(service, coffee_doc.uri)) {
        return NULL_SIGNATURE;
      }
      const fileFsPath = getFileFsPath(coffee_doc.uri);

      const transpilation = transpile_service.result_by_uri.get(coffee_doc.uri)
      if(!transpilation)
        return NULL_SIGNATURE

      const prev_coffee_char = coffee_doc.getText(Range.create(Position.create(position.line, position.character - 1), position))
      const next_coffee_char = coffee_doc.getText(Range.create(position, Position.create(position.line, position.character + 1)))
      if(transpilation.source_map) {
        position = transpile_service.position_coffee_to_js(transpilation, position, coffee_doc) || position
        if([' ', '('].includes(prev_coffee_char) && next_coffee_char === '\n') {
          // js: 3 characters backwards from eol: `\n`, `;`, `)`: into ()
          position.character = js_doc.positionAt(js_doc.offsetAt(Position.create(position.line, Number.MAX_VALUE)) - 3).character
        }
      }

      const signatureHelpItems = service.getSignatureHelpItems(fileFsPath, js_doc.offsetAt(position), undefined);
      if (!signatureHelpItems) {
        return NULL_SIGNATURE;
      }

      const signatures: SignatureInformation[] = [];
      signatureHelpItems.items.forEach(item => {
        let sigLabel = '';
        let sigMdDoc = '';
        const sigParamemterInfos: ParameterInformation[] = [];

        sigLabel += tsModule.displayPartsToString(item.prefixDisplayParts);
        item.parameters.forEach((p, i, a) => {
          const label = tsModule.displayPartsToString(p.displayParts);
          const parameter: ParameterInformation = {
            label,
            documentation: tsModule.displayPartsToString(p.documentation)
          };
          sigLabel += label;
          sigParamemterInfos.push(parameter);
          if (i < a.length - 1) {
            sigLabel += tsModule.displayPartsToString(item.separatorDisplayParts);
          }
        });
        sigLabel += tsModule.displayPartsToString(item.suffixDisplayParts);

        item.tags
          .filter(x => x.name !== 'param')
          .forEach(x => {
            const tagDoc = Previewer.getTagDocumentation(x);
            if (tagDoc) {
              sigMdDoc += tagDoc + '\n\n';
            }
          });

        signatures.push({
          label: sigLabel,
          documentation: {
            kind: 'markdown',
            value: sigMdDoc
          },
          parameters: sigParamemterInfos
        });
      });

      return {
        activeSignature: signatureHelpItems.selectedItemIndex,
        activeParameter: signatureHelpItems.argumentIndex,
        signatures
      };
    },
    findDocumentHighlight(doc: TextDocument, position: Position): DocumentHighlight[] {
      const { scriptDoc: js_doc, service } = updateCurrentCoffeescriptTextDocument(doc);
      if (!languageServiceIncludesFile(service, doc.uri)) {
        return [];
      }
      const fileFsPath = getFileFsPath(doc.uri);

      const transpilation = transpile_service.result_by_uri.get(doc.uri)
      if(!transpilation?.source_map)
        return []

      position = transpile_service.position_coffee_to_js(transpilation, position, doc) || position

      const js_text = js_doc.getText()

      const occurrences = service.getOccurrencesAtPosition(fileFsPath, js_doc.offsetAt(position));
      if (occurrences) {
        return occurrences
          .map(entry => ({
            entry,
            range: convertRange(js_doc, entry.textSpan)
          })).filter(({ range }) =>
            ! js_text.slice(js_doc.offsetAt({ line: range.start.line, character: 0 })).match(/^\s*var /)
          ).map(({ entry, range }) => {
            if(transpilation.source_map) {
              range = transpile_service.range_js_to_coffee(transpilation.source_map, range) || range
              if(range.end.line < range.start.line)
                range.end.line = range.start.line
              range.end.character = range.start.character + entry.textSpan.length
            }
            return {
              range,
              kind: entry.isWriteAccess ? DocumentHighlightKind.Write : DocumentHighlightKind.Text
            };
          });
      }
      return [];
    },
    findDocumentSymbols(doc: TextDocument): SymbolInformation[] {
      const { scriptDoc, service } = updateCurrentCoffeescriptTextDocument(doc);
      if (!languageServiceIncludesFile(service, doc.uri)) {
        return [];
      }
      const fileFsPath = getFileFsPath(doc.uri);

      const transpilation = transpile_service.result_by_uri.get(doc.uri)
      if(!transpilation?.source_map)
        return []

      const items = service.getNavigationBarItems(fileFsPath);
      if (!items) {
        return [];
      }
      const result: SymbolInformation[] = [];
      const existing: { [k: string]: boolean } = {};
      const collectSymbols = (item: ts.NavigationBarItem, containerLabel?: string) => {
        const sig = item.text + item.kind + item.spans[0]!.start;
        if (item.kind !== 'script' && !existing[sig]) {
          let range = convertRange(scriptDoc, item.spans[0]!)
          if(transpilation?.source_map)
            range = transpile_service.range_js_to_coffee(transpilation.source_map, range) || range
          const symbol: SymbolInformation = {
            name: item.text,
            kind: toSymbolKind(item.kind),
            location: {
              uri: doc.uri,
              range
            },
            containerName: containerLabel
          };
          existing[sig] = true;
          result.push(symbol);
          containerLabel = item.text;
        }

        if (item.childItems && item.childItems.length > 0) {
          for (const child of item.childItems) {
            collectSymbols(child, containerLabel);
          }
        }
      };

      items.forEach(item => collectSymbols(item));
      return result;
    },
    findDefinition(coffee_doc: TextDocument, position: Position): Definition {
      const { scriptDoc: js_doc, service } = updateCurrentCoffeescriptTextDocument(coffee_doc);
      if (!languageServiceIncludesFile(service, coffee_doc.uri)) {
        return [];
      }
      const fileFsPath = getFileFsPath(coffee_doc.uri);

      const transpilation = transpile_service.result_by_uri.get(coffee_doc.uri)
      if(!transpilation)
        return []
    
      if(transpilation.source_map)
        position = transpile_service.position_coffee_to_js(transpilation, position, coffee_doc) || position

      const definitions = service.getDefinitionAtPosition(fileFsPath, js_doc.offsetAt(position));
      if (!definitions) {
        return [];
      }

      const definitionResults: Definition = [];
      const program = service.getProgram();
      if (!program) {
        return [];
      }
      definitions.forEach(d => {
        const definitionTargetDoc = getSourceDoc(d.fileName, program);
        let range = convertRange(definitionTargetDoc, d.textSpan)
        const uri = URI.file(d.fileName).toString()
        const uri_transpilation = transpile_service.result_by_uri.get(uri)
        if(uri_transpilation?.source_map)
          range = transpile_service.range_js_to_coffee(uri_transpilation.source_map, range) || range
        definitionResults.push({
          uri,
          range
        });
      });
      return definitionResults;
    },
    findReferences(doc: TextDocument, position: Position): Location[] {
      const { scriptDoc, service } = updateCurrentCoffeescriptTextDocument(doc);
      if (!languageServiceIncludesFile(service, doc.uri)) {
        return [];
      }
      const fileFsPath = getFileFsPath(doc.uri);

      const transpilation = transpile_service.result_by_uri.get(doc.uri)
      if(!transpilation)
        return []

      if(transpilation.source_map)
        position = transpile_service.position_coffee_to_js(transpilation, position, doc) || position

      const references = service.getReferencesAtPosition(fileFsPath, scriptDoc.offsetAt(position));
      if (!references) {
        return [];
      }

      const referenceResults: Location[] = [];
      const program = service.getProgram();
      if (!program) {
        return [];
      }
      references.forEach(r => {
        const referenceTargetDoc = getSourceDoc(r.fileName, program);

        let range = convertRange(referenceTargetDoc, r.textSpan)
        const uri = URI.file(r.fileName).toString()
        const uri_transpilation = transpile_service.result_by_uri.get(uri)
        if(uri_transpilation?.source_map)
          range = transpile_service.range_js_to_coffee(uri_transpilation.source_map, range) || range
        if (referenceTargetDoc) {
          referenceResults.push({
            uri,
            range
          });
        }
      });
      return referenceResults;
    },
    getCodeActions(doc: TextDocument, coffee_range: Range, context: CodeActionContext) {
      const transpilation = transpile_service.result_by_uri.get(doc.uri)
      if(!transpilation?.source_map)
        return []
      const js_range = transpile_service.range_coffee_to_js(transpilation, coffee_range, doc)
      if(!js_range)
        return []

      const { scriptDoc, service } = updateCurrentCoffeescriptTextDocument(doc);
      const fileName = getFileFsPath(scriptDoc.uri);
      const start = scriptDoc.offsetAt(js_range.start);
      const end = scriptDoc.offsetAt(js_range.end);
      const textRange = { pos: start, end };
      const preferences = getUserPreferences(scriptDoc);
      if (!supportedCodeFixCodes) {
        supportedCodeFixCodes = new Set(
          tsModule
            .getSupportedCodeFixes()
            .map(Number)
            .filter(x => !isNaN(x))
        );
      }

      const result: CodeAction[] = [];
      provideOrganizeImports(doc.uri, scriptDoc.languageId as LanguageId, textRange, context, result);

      return result;
    },
    doCodeActionResolve(doc, action) {
      const { scriptDoc, service } = updateCurrentCoffeescriptTextDocument(doc);
      if (!languageServiceIncludesFile(service, doc.uri)) {
        return action;
      }
      const transpilation = transpile_service.result_by_uri.get(doc.uri)
      if(!transpilation?.source_map)
        return action;

      const preferences = getUserPreferences(scriptDoc);

      const fileFsPath = getFileFsPath(doc.uri);
      const data = action.data as CodeActionData;

      if (data.kind === CodeActionDataKind.OrganizeImports) {
        const text_range_length = data.textRange.end - data.textRange.pos
        const mapped_pos_start = transpile_service.position_coffee_to_js(transpilation, doc.positionAt(data.textRange.pos), doc)
        if(!mapped_pos_start)
          return action
        data.textRange.pos = doc.offsetAt(mapped_pos_start)
        data.textRange.end = data.textRange.pos + text_range_length
        
        const response = service.organizeImports({ type: 'file', fileName: fileFsPath }, {}, preferences);
        const edit = { changes: createUriMappingForEdits(response.slice(), service) };
        
        const doc_changes = edit.changes?.[doc.uri] || []
        for(const change of doc_changes) {
          const range = transpile_service.range_js_to_coffee(transpilation.source_map, change.range)
          if(!range)
            return action
          if(change.range.start.line === change.range.end.line && change.range.start.character === 0 && change.range.end.character === 0)
            // Import removed; fix line range
            change.range.end.line++
        }
        
        action.edit = edit
      }

      delete action.data;
      return action;
    },
    onDocumentRemoved(document: TextDocument) {
      jsDocuments.onDocumentRemoved(document);
    },
    onDocumentChanged(filePath: string) {
      serviceHost.updateExternalDocument(filePath);
    },
    dispose() {
      jsDocuments.dispose();
    }
  };
}

function provideOrganizeImports(
  uri: string,
  languageId: LanguageId,
  textRange: { pos: number; end: number },
  context: CodeActionContext,
  result: CodeAction[]
) {
  if (
    !context.only ||
    (!context.only.includes(CodeActionKind.SourceOrganizeImports) && !context.only.includes(CodeActionKind.Source))
  ) {
    return;
  }

  result.push({
    title: 'Organize Imports',
    kind: CodeActionKind.SourceOrganizeImports,
    data: {
      uri,
      languageId,
      textRange,
      kind: CodeActionDataKind.OrganizeImports
    } as OrganizeImportsActionData
  });
}

function createUriMappingForEdits(changes: ts.FileTextChanges[], service: ts.LanguageService) {
  const program = service.getProgram()!;
  const result: Record<string, TextEdit[]> = {};
  for (const { fileName, textChanges } of changes) {
    const targetDoc = getSourceDoc(fileName, program);
    const edits = textChanges.map(({ newText, span }) => ({
      newText,
      range: convertRange(targetDoc, span)
    }));
    const uri = URI.file(fileName).toString();
    if (result[uri]) {
      result[uri]!.push(...edits);
    } else {
      result[uri] = edits;
    }
  }
  return result;
}

function getSourceDoc(fileName: string, program: ts.Program): TextDocument {
  const sourceFile = program.getSourceFile(fileName)!;
  return TextDocument.create(fileName, LANGUAGE_ID, 0, sourceFile.getFullText());
}

export function languageServiceIncludesFile(ls: ts.LanguageService, documentUri: string): boolean {
  const filePaths = ls.getProgram()!.getRootFileNames();
  const filePath = getFilePath(documentUri);
  return filePaths.includes(filePath);
}

function convertRange(document: TextDocument, span: ts.TextSpan): Range {
  const startPosition = document.positionAt(span.start);
  const endPosition = document.positionAt(span.start + span.length);
  return Range.create(startPosition, endPosition);
}

// Parameter must to be string, Otherwise I don't like it semantically.
function getTsTriggerCharacter(triggerChar: string) {
  // Sometimes autocomplete does not work with spaces indented inside objects (empty line).
  // Not sure why, but TS rejects space as a valid trigger character in these scenarios.
  // This function does not make any sense anymore anyway in CoffeeScript land: Most of
  // these tokens have a completely different meaning than in JS.
  // Setting to `.` allows for completion, no matter what. (typescript.js: `isValidTrigger`)
  return '.';
  const legalChars = ['@', '#', '.', '"', "'", '`', '/', '<', ' '];
  if (legalChars.includes(triggerChar)) {
    return triggerChar as ts.CompletionsTriggerCharacter;
  }
  return undefined;
}

function parseKindModifier(kindModifiers: string) {
  const kinds = new Set(kindModifiers.split(/,|\s+/g));

  return {
    optional: kinds.has('optional'),
    deprecated: kinds.has('deprecated'),
    color: kinds.has('color')
  };
}

function convertTSDiagnosticCategoryToDiagnosticSeverity(
  tsModule: RuntimeLibrary['typescript'],
  c: ts.DiagnosticCategory
) {
  switch (c) {
    case tsModule.DiagnosticCategory.Error:
      return DiagnosticSeverity.Error;
    case tsModule.DiagnosticCategory.Warning:
      return DiagnosticSeverity.Warning;
    case tsModule.DiagnosticCategory.Message:
      return DiagnosticSeverity.Information;
    case tsModule.DiagnosticCategory.Suggestion:
      return DiagnosticSeverity.Hint;
    default:
      return DiagnosticSeverity.Error;
  }
}

/* tslint:disable:max-line-length */
/**
 * Adapted from https://github.com/microsoft/vscode/blob/2b090abd0fdab7b21a3eb74be13993ad61897f84/extensions/typescript-language-features/src/languageFeatures/completions.ts#L147-L181
 */
function getFilterText(insertText: string | undefined): string | undefined {
  // For `this.` completions, generally don't set the filter text since we don't want them to be overly prioritized. #74164
  if (insertText?.startsWith('this.')) {
    return undefined;
  }

  // Handle the case:
  // ```
  // const xyz = { 'ab c': 1 };
  // xyz.ab|
  // ```
  // In which case we want to insert a bracket accessor but should use `.abc` as the filter text instead of
  // the bracketed insert text.
  else if (insertText?.startsWith('[')) {
    return insertText.replace(/^\[['"](.+)[['"]\]$/, '.$1');
  }

  // In all other cases, fallback to using the insertText
  return insertText;
}