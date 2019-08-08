import { CUSTOM_TAGS, CustomTag } from "./../model/custom-tags"

import {
	ArrayASTNode,
	ASTNode,
	BooleanASTNode,
	ErrorCode,
	JSONDocument,
	NullASTNode,
	NumberASTNode,
	ObjectASTNode,
	PropertyASTNode,
	StringASTNode
} from "./json"

import * as nls from "vscode-nls"
const localize = nls.loadMessageBundle()

import { Schema, Type } from "js-yaml"
import * as Yaml from "yaml-ast-parser"

import { GlobalsConfig } from "../model/globals"
import { collectGlobals, getDefaultGlobalsConfig } from "./globals"
import { parseYamlBoolean } from "./scalar-type"
import { ResourcesDefinitions } from "../model/resources"
import { DocumentType } from "../model/document"
import { getDocumentType } from "../utils/document"

export interface Problem {
	message: string
	location: {
		start: number
		end: number
	}
	code: ErrorCode
}

interface YamlScalar extends Yaml.YAMLScalar {
	customTag?: CustomTag
}

interface YamlSequence extends Yaml.YAMLSequence {
	customTag?: CustomTag
}

export class YAMLDocument extends JSONDocument {
	root: ASTNode
	errors: Problem[]
	warnings: Problem[]
	globalsConfig: GlobalsConfig
	resources: ResourcesDefinitions
	parameters: string[]
	documentType: DocumentType

	constructor(documentType: DocumentType) {
		super(null, [])
		this.documentType = documentType
		this.globalsConfig = getDefaultGlobalsConfig()
		this.root = null
		this.errors = []
		this.warnings = []
	}

	getSchemas(schema, doc, node: ASTNode) {
		const matchingSchemas = []
		doc.validate(schema, matchingSchemas, node.start)
		return matchingSchemas
	}

	getNodeFromOffset(offset: number): ASTNode {
		return this.getNodeFromOffsetEndInclusive(offset)
	}
}

function recursivelyBuildAst(parent: ASTNode, node: Yaml.YAMLNode): ASTNode {
	if (!node) {
		return
	}

	switch (node.kind) {
		case Yaml.Kind.MAP: {
			const instance = node as Yaml.YamlMap

			const result = new ObjectASTNode(
				parent,
				null,
				node.startPosition,
				node.endPosition
			)

			for (const mapping of instance.mappings) {
				result.addProperty(recursivelyBuildAst(
					result,
					mapping
				) as PropertyASTNode)
			}

			return result
		}
		case Yaml.Kind.MAPPING: {
			const instance = node as Yaml.YAMLMapping
			const key = instance.key

			// Technically, this is an arbitrary node in YAML
			// I doubt we would get a better string representation by parsing it
			const keyNode = new StringASTNode(
				null,
				null,
				true,
				key.startPosition,
				key.endPosition
			)
			keyNode.value = key.value

			const result = new PropertyASTNode(parent, keyNode)
			result.end = instance.endPosition

			const valueNode = instance.value
				? recursivelyBuildAst(result, instance.value)
				: new NullASTNode(
						parent,
						key.value,
						instance.endPosition,
						instance.endPosition
				  )
			valueNode.location = key.value

			result.setValue(valueNode)

			return result
		}
		case Yaml.Kind.SEQ: {
			const instance = node as YamlSequence

			const result = new ArrayASTNode(
				parent,
				null,
				instance.startPosition,
				instance.endPosition,
				instance.customTag
			)

			let count = 0
			for (const item of instance.items) {
				if (item === null && count === instance.items.length - 1) {
					break
				}

				// Be aware of https://github.com/nodeca/js-yaml/issues/321
				// Cannot simply work around it here because we need to know if we are in Flow or Block
				const itemNode =
					item === null
						? new NullASTNode(
								parent,
								null,
								instance.endPosition,
								instance.endPosition
						  )
						: recursivelyBuildAst(result, item)

				itemNode.location = count++
				result.addItem(itemNode)
			}

			return result
		}
		case Yaml.Kind.SCALAR: {
			const instance = node as YamlScalar
			const type = Yaml.determineScalarType(instance)

			// The name is set either by the sequence or the mapping case.
			const name = null
			const value = instance.value

			// This is a patch for redirecting values with these strings to be boolean nodes because its not supported in the parser.
			const possibleBooleanValues = [
				"y",
				"Y",
				"yes",
				"Yes",
				"YES",
				"n",
				"N",
				"no",
				"No",
				"NO",
				"on",
				"On",
				"ON",
				"off",
				"Off",
				"OFF"
			]
			if (
				instance.plainScalar &&
				possibleBooleanValues.indexOf(value.toString()) !== -1
			) {
				return new BooleanASTNode(
					parent,
					name,
					parseYamlBoolean(value),
					node.startPosition,
					node.endPosition
				)
			}

			switch (type) {
				case Yaml.ScalarType.null: {
					return new StringASTNode(
						parent,
						name,
						false,
						instance.startPosition,
						instance.endPosition
					)
				}
				case Yaml.ScalarType.bool: {
					return new BooleanASTNode(
						parent,
						name,
						Yaml.parseYamlBoolean(value),
						node.startPosition,
						node.endPosition
					)
				}
				case Yaml.ScalarType.int: {
					const result = new NumberASTNode(
						parent,
						name,
						node.startPosition,
						node.endPosition
					)
					result.value = Yaml.parseYamlInteger(value)
					result.isInteger = true
					return result
				}
				case Yaml.ScalarType.float: {
					const result = new NumberASTNode(
						parent,
						name,
						node.startPosition,
						node.endPosition
					)
					result.value = Yaml.parseYamlFloat(value)
					result.isInteger = false
					return result
				}
				case Yaml.ScalarType.string: {
					const result = new StringASTNode(
						parent,
						name,
						false,
						node.startPosition,
						node.endPosition,
						instance.customTag
					)
					result.value = node.value
					return result
				}
			}

			break
		}
		case Yaml.Kind.ANCHOR_REF: {
			const instance = (node as Yaml.YAMLAnchorReference).value

			return (
				recursivelyBuildAst(parent, instance) ||
				new NullASTNode(
					parent,
					null,
					node.startPosition,
					node.endPosition
				)
			)
		}
		case Yaml.Kind.INCLUDE_REF: {
			const result = new StringASTNode(
				parent,
				null,
				false,
				node.startPosition,
				node.endPosition
			)
			result.value = node.value
			return result
		}
	}
}

function convertError(e: Yaml.YAMLException): Problem {
	return {
		message: `${e.reason}`,
		location: {
			start: e.mark.position,
			end: e.mark.position + e.mark.column
		},
		code: ErrorCode.Undefined
	}
}

function createJSONDocument(yamlDoc: Yaml.YAMLNode | void, text: string) {
	const doc = new YAMLDocument(getDocumentType(text))

	if (yamlDoc) {
		doc.root = recursivelyBuildAst(null, yamlDoc)
	}

	if (!yamlDoc || !doc.root) {
		// TODO: When this is true, consider not pushing the other errors.
		doc.errors.push({
			message: localize(
				"Invalid symbol",
				"Expected a YAML object, array or literal"
			),
			code: ErrorCode.Undefined,
			location: yamlDoc
				? {
						start: yamlDoc.startPosition,
						end: yamlDoc.endPosition
				  }
				: { start: 0, end: 0 }
		})

		return doc
	}

	doc.globalsConfig = collectGlobals(doc.root)

	const duplicateKeyReason = "duplicate key"

	// Patch ontop of yaml-ast-parser to disable duplicate key message on merge key
	const isDuplicateAndNotMergeKey = (
		error: Yaml.YAMLException,
		yamlText: string
	) => {
		const errorConverted = convertError(error)
		const errorStart = errorConverted.location.start
		const errorEnd = errorConverted.location.end
		if (
			error.reason === duplicateKeyReason &&
			yamlText.substring(errorStart, errorEnd).startsWith("<<")
		) {
			return false
		}
		return true
	}
	doc.errors = yamlDoc.errors
		.filter(e => e.reason !== duplicateKeyReason && !e.isWarning)
		.map(e => convertError(e))
	doc.warnings = yamlDoc.errors
		.filter(
			e =>
				(e.reason === duplicateKeyReason &&
					isDuplicateAndNotMergeKey(e, text)) ||
				e.isWarning
		)
		.map(e => convertError(e))

	return doc
}

export const parse = (text: string): YAMLDocument => {
	// We need compiledTypeMap to be available from schemaWithAdditionalTags before we add the new custom propertie
	const compiledTypeMap: { [key: string]: Type } = {}

	CUSTOM_TAGS.forEach(customTag => {
		if (customTag.tag) {
			compiledTypeMap[customTag.tag] = new Type(customTag.tag, {
				kind: customTag.kind,
				construct: data => {
					if (data) {
						data.customTag = customTag

						return data
					}

					return null
				}
			})
		}
	})

	const schemaWithAdditionalTags = Schema.create(
		Object.values(compiledTypeMap)
	)
	;(schemaWithAdditionalTags as any).compiledTypeMap = compiledTypeMap

	const additionalOptions: Yaml.LoadOptions = {
		schema: schemaWithAdditionalTags
	}

	return createJSONDocument(Yaml.load(text, additionalOptions), text)
}
