import {
  ASTVisitor,
  DirectiveNode,
  FieldNode,
  FragmentDefinitionNode,
  getNamedType,
  GraphQLField,
  GraphQLNamedType,
  GraphQLOutputType,
  isInterfaceType,
  isLeafType,
  isListType,
  isNonNullType,
  isObjectType,
  Kind,
  ObjectFieldNode,
  ObjectValueNode,
  print,
  SelectionSetNode,
  typeFromAST,
  ValidationContext,
  ValueNode,
} from 'graphql'
import { createGraphQLError, inspect, Maybe } from '@graphql-tools/utils'

/**
 * Returns a number indicating whether a reference string comes before, or after,
 * or is the same as the given string in natural sort order.
 *
 * See: https://en.wikipedia.org/wiki/Natural_sort_order
 *
 */
export function naturalCompare(aStr: string, bStr: string): number {
  let aIndex = 0
  let bIndex = 0

  while (aIndex < aStr.length && bIndex < bStr.length) {
    let aChar = aStr.charCodeAt(aIndex)
    let bChar = bStr.charCodeAt(bIndex)

    if (isDigit(aChar) && isDigit(bChar)) {
      let aNum = 0
      do {
        ++aIndex
        aNum = aNum * 10 + aChar - DIGIT_0
        aChar = aStr.charCodeAt(aIndex)
      } while (isDigit(aChar) && aNum > 0)

      let bNum = 0
      do {
        ++bIndex
        bNum = bNum * 10 + bChar - DIGIT_0
        bChar = bStr.charCodeAt(bIndex)
      } while (isDigit(bChar) && bNum > 0)

      if (aNum < bNum) {
        return -1
      }

      if (aNum > bNum) {
        return 1
      }
    } else {
      if (aChar < bChar) {
        return -1
      }
      if (aChar > bChar) {
        return 1
      }
      ++aIndex
      ++bIndex
    }
  }

  return aStr.length - bStr.length
}

const DIGIT_0 = 48
const DIGIT_9 = 57

function isDigit(code: number): boolean {
  return !isNaN(code) && DIGIT_0 <= code && code <= DIGIT_9
}

function sortValueNode(valueNode: ValueNode): ValueNode {
  switch (valueNode.kind) {
    case Kind.OBJECT:
      return {
        ...valueNode,
        fields: sortFields(valueNode.fields),
      }
    case Kind.LIST:
      return {
        ...valueNode,
        values: valueNode.values.map(sortValueNode),
      }
    case Kind.INT:
    case Kind.FLOAT:
    case Kind.STRING:
    case Kind.BOOLEAN:
    case Kind.NULL:
    case Kind.ENUM:
    case Kind.VARIABLE:
      return valueNode
  }
}

function sortFields(
  fields: ReadonlyArray<ObjectFieldNode>,
): Array<ObjectFieldNode> {
  return fields
    .map((fieldNode) => ({
      ...fieldNode,
      value: sortValueNode(fieldNode.value),
    }))
    .sort((fieldA, fieldB) =>
      naturalCompare(fieldA.name.value, fieldB.name.value),
    )
}

function reasonMessage(reason: ConflictReasonMessage): string {
  if (Array.isArray(reason)) {
    return reason
      .map(
        ([responseName, subReason]) =>
          `subfields "${responseName}" conflict because ` +
          reasonMessage(subReason),
      )
      .join(' and ')
  }
  return reason
}

/**
 * Overlapping fields can be merged
 *
 * A selection set is only valid if all fields (including spreading any
 * fragments) either correspond to distinct response names or can be merged
 * without ambiguity.
 *
 * See https://spec.graphql.org/draft/#sec-Field-Selection-Merging
 */
export function OverlappingFieldsCanBeMergedRule(
  context: ValidationContext,
): ASTVisitor {
  // A memoization for when two fragments are compared "between" each other for
  // conflicts. Two fragments may be compared many times, so memoizing this can
  // dramatically improve the performance of this validator.
  const comparedFragmentPairs = new PairSet()

  // A cache for the "field map" and list of fragment names found in any given
  // selection set. Selection sets may be asked for this information multiple
  // times, so this improves the performance of this validator.
  const cachedFieldsAndFragmentNames = new Map()

  return {
    SelectionSet(selectionSet) {
      const conflicts = findConflictsWithinSelectionSet(
        context,
        cachedFieldsAndFragmentNames,
        comparedFragmentPairs,
        context.getParentType(),
        selectionSet,
      )
      for (const [[responseName, reason], fields1, fields2] of conflicts) {
        const reasonMsg = reasonMessage(reason)
        context.reportError(
          createGraphQLError(
            `Fields "${responseName}" conflict because ${reasonMsg}. Use different aliases on the fields to fetch both if this was intentional.`,
            { nodes: fields1.concat(fields2) },
          ),
        )
      }
    },
  }
}

type Conflict = [ConflictReason, Array<FieldNode>, Array<FieldNode>]
// Field name and reason.
type ConflictReason = [string, ConflictReasonMessage]
// Reason is a string, or a nested list of conflicts.
type ConflictReasonMessage = string | Array<ConflictReason>
// Tuple defining a field node in a context.
type NodeAndDef = [
  Maybe<GraphQLNamedType>,
  FieldNode,
  Maybe<GraphQLField<unknown, unknown>>,
]
// Map of array of those.
type NodeAndDefCollection = Record<string, Array<NodeAndDef>>
type FragmentNames = ReadonlyArray<string>
type FieldsAndFragmentNames = readonly [NodeAndDefCollection, FragmentNames]

/**
 * Algorithm:
 *
 * Conflicts occur when two fields exist in a query which will produce the same
 * response name, but represent differing values, thus creating a conflict.
 * The algorithm below finds all conflicts via making a series of comparisons
 * between fields. In order to compare as few fields as possible, this makes
 * a series of comparisons "within" sets of fields and "between" sets of fields.
 *
 * Given any selection set, a collection produces both a set of fields by
 * also including all inline fragments, as well as a list of fragments
 * referenced by fragment spreads.
 *
 * A) Each selection set represented in the document first compares "within" its
 * collected set of fields, finding any conflicts between every pair of
 * overlapping fields.
 * Note: This is the *only time* that a the fields "within" a set are compared
 * to each other. After this only fields "between" sets are compared.
 *
 * B) Also, if any fragment is referenced in a selection set, then a
 * comparison is made "between" the original set of fields and the
 * referenced fragment.
 *
 * C) Also, if multiple fragments are referenced, then comparisons
 * are made "between" each referenced fragment.
 *
 * D) When comparing "between" a set of fields and a referenced fragment, first
 * a comparison is made between each field in the original set of fields and
 * each field in the the referenced set of fields.
 *
 * E) Also, if any fragment is referenced in the referenced selection set,
 * then a comparison is made "between" the original set of fields and the
 * referenced fragment (recursively referring to step D).
 *
 * F) When comparing "between" two fragments, first a comparison is made between
 * each field in the first referenced set of fields and each field in the the
 * second referenced set of fields.
 *
 * G) Also, any fragments referenced by the first must be compared to the
 * second, and any fragments referenced by the second must be compared to the
 * first (recursively referring to step F).
 *
 * H) When comparing two fields, if both have selection sets, then a comparison
 * is made "between" both selection sets, first comparing the set of fields in
 * the first selection set with the set of fields in the second.
 *
 * I) Also, if any fragment is referenced in either selection set, then a
 * comparison is made "between" the other set of fields and the
 * referenced fragment.
 *
 * J) Also, if two fragments are referenced in both selection sets, then a
 * comparison is made "between" the two fragments.
 *
 */

// Find all conflicts found "within" a selection set, including those found
// via spreading in fragments. Called when visiting each SelectionSet in the
// GraphQL Document.
function findConflictsWithinSelectionSet(
  context: ValidationContext,
  cachedFieldsAndFragmentNames: Map<SelectionSetNode, FieldsAndFragmentNames>,
  comparedFragmentPairs: PairSet,
  parentType: Maybe<GraphQLNamedType>,
  selectionSet: SelectionSetNode,
): Array<Conflict> {
  const conflicts: Array<Conflict> = []

  const [fieldMap, fragmentNames] = getFieldsAndFragmentNames(
    context,
    cachedFieldsAndFragmentNames,
    parentType,
    selectionSet,
  )

  // (A) Find find all conflicts "within" the fields of this selection set.
  // Note: this is the *only place* `collectConflictsWithin` is called.
  collectConflictsWithin(
    context,
    conflicts,
    cachedFieldsAndFragmentNames,
    comparedFragmentPairs,
    fieldMap,
  )

  if (fragmentNames.length !== 0) {
    // (B) Then collect conflicts between these fields and those represented by
    // each spread fragment name found.
    for (let i = 0; i < fragmentNames.length; i++) {
      collectConflictsBetweenFieldsAndFragment(
        context,
        conflicts,
        cachedFieldsAndFragmentNames,
        comparedFragmentPairs,
        false,
        fieldMap,
        fragmentNames[i],
      )
      // (C) Then compare this fragment with all other fragments found in this
      // selection set to collect conflicts between fragments spread together.
      // This compares each item in the list of fragment names to every other
      // item in that same list (except for itself).
      for (let j = i + 1; j < fragmentNames.length; j++) {
        collectConflictsBetweenFragments(
          context,
          conflicts,
          cachedFieldsAndFragmentNames,
          comparedFragmentPairs,
          false,
          fragmentNames[i],
          fragmentNames[j],
        )
      }
    }
  }
  return conflicts
}

// Collect all conflicts found between a set of fields and a fragment reference
// including via spreading in any nested fragments.
function collectConflictsBetweenFieldsAndFragment(
  context: ValidationContext,
  conflicts: Array<Conflict>,
  cachedFieldsAndFragmentNames: Map<SelectionSetNode, FieldsAndFragmentNames>,
  comparedFragmentPairs: PairSet,
  areMutuallyExclusive: boolean,
  fieldMap: NodeAndDefCollection,
  fragmentName: string,
): void {
  const fragment = context.getFragment(fragmentName)
  if (!fragment) {
    return
  }

  const [fieldMap2, referencedFragmentNames] =
    getReferencedFieldsAndFragmentNames(
      context,
      cachedFieldsAndFragmentNames,
      fragment,
    )

  // Do not compare a fragment's fieldMap to itself.
  if (fieldMap === fieldMap2) {
    return
  }

  // (D) First collect any conflicts between the provided collection of fields
  // and the collection of fields represented by the given fragment.
  collectConflictsBetween(
    context,
    conflicts,
    cachedFieldsAndFragmentNames,
    comparedFragmentPairs,
    areMutuallyExclusive,
    fieldMap,
    fieldMap2,
  )

  // (E) Then collect any conflicts between the provided collection of fields
  // and any fragment names found in the given fragment.
  for (const referencedFragmentName of referencedFragmentNames) {
    // Memoize so two fragments are not compared for conflicts more than once.
    if (
      comparedFragmentPairs.has(
        referencedFragmentName,
        fragmentName,
        areMutuallyExclusive,
      )
    ) {
      continue
    }
    comparedFragmentPairs.add(
      referencedFragmentName,
      fragmentName,
      areMutuallyExclusive,
    )

    collectConflictsBetweenFieldsAndFragment(
      context,
      conflicts,
      cachedFieldsAndFragmentNames,
      comparedFragmentPairs,
      areMutuallyExclusive,
      fieldMap,
      referencedFragmentName,
    )
  }
}

// Collect all conflicts found between two fragments, including via spreading in
// any nested fragments.
function collectConflictsBetweenFragments(
  context: ValidationContext,
  conflicts: Array<Conflict>,
  cachedFieldsAndFragmentNames: Map<SelectionSetNode, FieldsAndFragmentNames>,
  comparedFragmentPairs: PairSet,
  areMutuallyExclusive: boolean,
  fragmentName1: string,
  fragmentName2: string,
): void {
  // No need to compare a fragment to itself.
  if (fragmentName1 === fragmentName2) {
    return
  }

  // Memoize so two fragments are not compared for conflicts more than once.
  if (
    comparedFragmentPairs.has(
      fragmentName1,
      fragmentName2,
      areMutuallyExclusive,
    )
  ) {
    return
  }
  comparedFragmentPairs.add(fragmentName1, fragmentName2, areMutuallyExclusive)

  const fragment1 = context.getFragment(fragmentName1)
  const fragment2 = context.getFragment(fragmentName2)
  if (!fragment1 || !fragment2) {
    return
  }

  const [fieldMap1, referencedFragmentNames1] =
    getReferencedFieldsAndFragmentNames(
      context,
      cachedFieldsAndFragmentNames,
      fragment1,
    )
  const [fieldMap2, referencedFragmentNames2] =
    getReferencedFieldsAndFragmentNames(
      context,
      cachedFieldsAndFragmentNames,
      fragment2,
    )

  // (F) First, collect all conflicts between these two collections of fields
  // (not including any nested fragments).
  collectConflictsBetween(
    context,
    conflicts,
    cachedFieldsAndFragmentNames,
    comparedFragmentPairs,
    areMutuallyExclusive,
    fieldMap1,
    fieldMap2,
  )

  // (G) Then collect conflicts between the first fragment and any nested
  // fragments spread in the second fragment.
  for (const referencedFragmentName2 of referencedFragmentNames2) {
    collectConflictsBetweenFragments(
      context,
      conflicts,
      cachedFieldsAndFragmentNames,
      comparedFragmentPairs,
      areMutuallyExclusive,
      fragmentName1,
      referencedFragmentName2,
    )
  }

  // (G) Then collect conflicts between the second fragment and any nested
  // fragments spread in the first fragment.
  for (const referencedFragmentName1 of referencedFragmentNames1) {
    collectConflictsBetweenFragments(
      context,
      conflicts,
      cachedFieldsAndFragmentNames,
      comparedFragmentPairs,
      areMutuallyExclusive,
      referencedFragmentName1,
      fragmentName2,
    )
  }
}

// Find all conflicts found between two selection sets, including those found
// via spreading in fragments. Called when determining if conflicts exist
// between the sub-fields of two overlapping fields.
function findConflictsBetweenSubSelectionSets(
  context: ValidationContext,
  cachedFieldsAndFragmentNames: Map<SelectionSetNode, FieldsAndFragmentNames>,
  comparedFragmentPairs: PairSet,
  areMutuallyExclusive: boolean,
  parentType1: Maybe<GraphQLNamedType>,
  selectionSet1: SelectionSetNode,
  parentType2: Maybe<GraphQLNamedType>,
  selectionSet2: SelectionSetNode,
): Array<Conflict> {
  const conflicts: Array<Conflict> = []

  const [fieldMap1, fragmentNames1] = getFieldsAndFragmentNames(
    context,
    cachedFieldsAndFragmentNames,
    parentType1,
    selectionSet1,
  )
  const [fieldMap2, fragmentNames2] = getFieldsAndFragmentNames(
    context,
    cachedFieldsAndFragmentNames,
    parentType2,
    selectionSet2,
  )

  // (H) First, collect all conflicts between these two collections of field.
  collectConflictsBetween(
    context,
    conflicts,
    cachedFieldsAndFragmentNames,
    comparedFragmentPairs,
    areMutuallyExclusive,
    fieldMap1,
    fieldMap2,
  )

  // (I) Then collect conflicts between the first collection of fields and
  // those referenced by each fragment name associated with the second.
  for (const fragmentName2 of fragmentNames2) {
    collectConflictsBetweenFieldsAndFragment(
      context,
      conflicts,
      cachedFieldsAndFragmentNames,
      comparedFragmentPairs,
      areMutuallyExclusive,
      fieldMap1,
      fragmentName2,
    )
  }

  // (I) Then collect conflicts between the second collection of fields and
  // those referenced by each fragment name associated with the first.
  for (const fragmentName1 of fragmentNames1) {
    collectConflictsBetweenFieldsAndFragment(
      context,
      conflicts,
      cachedFieldsAndFragmentNames,
      comparedFragmentPairs,
      areMutuallyExclusive,
      fieldMap2,
      fragmentName1,
    )
  }

  // (J) Also collect conflicts between any fragment names by the first and
  // fragment names by the second. This compares each item in the first set of
  // names to each item in the second set of names.
  for (const fragmentName1 of fragmentNames1) {
    for (const fragmentName2 of fragmentNames2) {
      collectConflictsBetweenFragments(
        context,
        conflicts,
        cachedFieldsAndFragmentNames,
        comparedFragmentPairs,
        areMutuallyExclusive,
        fragmentName1,
        fragmentName2,
      )
    }
  }
  return conflicts
}

// Collect all Conflicts "within" one collection of fields.
function collectConflictsWithin(
  context: ValidationContext,
  conflicts: Array<Conflict>,
  cachedFieldsAndFragmentNames: Map<SelectionSetNode, FieldsAndFragmentNames>,
  comparedFragmentPairs: PairSet,
  fieldMap: NodeAndDefCollection,
): void {
  // A field map is a keyed collection, where each key represents a response
  // name and the value at that key is a list of all fields which provide that
  // response name. For every response name, if there are multiple fields, they
  // must be compared to find a potential conflict.
  for (const [responseName, fields] of Object.entries(fieldMap)) {
    // This compares every field in the list to every other field in this list
    // (except to itself). If the list only has one item, nothing needs to
    // be compared.
    if (fields.length > 1) {
      for (let i = 0; i < fields.length; i++) {
        for (let j = i + 1; j < fields.length; j++) {
          const conflict = findConflict(
            context,
            cachedFieldsAndFragmentNames,
            comparedFragmentPairs,
            false, // within one collection is never mutually exclusive
            responseName,
            fields[i],
            fields[j],
          )
          if (conflict) {
            conflicts.push(conflict)
          }
        }
      }
    }
  }
}

// Collect all Conflicts between two collections of fields. This is similar to,
// but different from the `collectConflictsWithin` function above. This check
// assumes that `collectConflictsWithin` has already been called on each
// provided collection of fields. This is true because this validator traverses
// each individual selection set.
function collectConflictsBetween(
  context: ValidationContext,
  conflicts: Array<Conflict>,
  cachedFieldsAndFragmentNames: Map<SelectionSetNode, FieldsAndFragmentNames>,
  comparedFragmentPairs: PairSet,
  parentFieldsAreMutuallyExclusive: boolean,
  fieldMap1: NodeAndDefCollection,
  fieldMap2: NodeAndDefCollection,
): void {
  // A field map is a keyed collection, where each key represents a response
  // name and the value at that key is a list of all fields which provide that
  // response name. For any response name which appears in both provided field
  // maps, each field from the first field map must be compared to every field
  // in the second field map to find potential conflicts.
  for (const [responseName, fields1] of Object.entries(fieldMap1)) {
    const fields2 = fieldMap2[responseName]
    if (fields2) {
      for (const field1 of fields1) {
        for (const field2 of fields2) {
          const conflict = findConflict(
            context,
            cachedFieldsAndFragmentNames,
            comparedFragmentPairs,
            parentFieldsAreMutuallyExclusive,
            responseName,
            field1,
            field2,
          )
          if (conflict) {
            conflicts.push(conflict)
          }
        }
      }
    }
  }
}

// Determines if there is a conflict between two particular fields, including
// comparing their sub-fields.
function findConflict(
  context: ValidationContext,
  cachedFieldsAndFragmentNames: Map<SelectionSetNode, FieldsAndFragmentNames>,
  comparedFragmentPairs: PairSet,
  parentFieldsAreMutuallyExclusive: boolean,
  responseName: string,
  field1: NodeAndDef,
  field2: NodeAndDef,
): Maybe<Conflict> {
  const [parentType1, node1, def1] = field1
  const [parentType2, node2, def2] = field2

  // If it is known that two fields could not possibly apply at the same
  // time, due to the parent types, then it is safe to permit them to diverge
  // in aliased field or arguments used as they will not present any ambiguity
  // by differing.
  // It is known that two parent types could never overlap if they are
  // different Object types. Interface or Union types might overlap - if not
  // in the current state of the schema, then perhaps in some future version,
  // thus may not safely diverge.
  const areMutuallyExclusive =
    parentFieldsAreMutuallyExclusive ||
    (parentType1 !== parentType2 &&
      isObjectType(parentType1) &&
      isObjectType(parentType2))

  if (!areMutuallyExclusive) {
    // Two aliases must refer to the same field.
    const name1 = node1.name.value
    const name2 = node2.name.value
    if (name1 !== name2) {
      return [
        [responseName, `"${name1}" and "${name2}" are different fields`],
        [node1],
        [node2],
      ]
    }

    // Two field calls must have the same arguments.
    if (stringifyArguments(node1) !== stringifyArguments(node2)) {
      return [[responseName, 'they have differing arguments'], [node1], [node2]]
    }
  }

  // FIXME https://github.com/graphql/graphql-js/issues/2203
  const directives1 = /* c8 ignore next */ node1.directives ?? []
  const directives2 = /* c8 ignore next */ node2.directives ?? []
  if (!sameStreams(directives1, directives2)) {
    return [
      [responseName, 'they have differing stream directives'],
      [node1],
      [node2],
    ]
  }

  // The return type for each field.
  const type1 = def1?.type
  const type2 = def2?.type

  if (type1 && type2 && doTypesConflict(type1, type2)) {
    return [
      [
        responseName,
        `they return conflicting types "${inspect(type1)}" and "${inspect(
          type2,
        )}"`,
      ],
      [node1],
      [node2],
    ]
  }

  // Collect and compare sub-fields. Use the same "visited fragment names" list
  // for both collections so fields in a fragment reference are never
  // compared to themselves.
  const selectionSet1 = node1.selectionSet
  const selectionSet2 = node2.selectionSet
  if (selectionSet1 && selectionSet2) {
    const conflicts = findConflictsBetweenSubSelectionSets(
      context,
      cachedFieldsAndFragmentNames,
      comparedFragmentPairs,
      areMutuallyExclusive,
      getNamedType(type1 as GraphQLOutputType),
      selectionSet1,
      getNamedType(type2 as GraphQLOutputType),
      selectionSet2,
    )
    return subfieldConflicts(conflicts, responseName, node1, node2)
  }
  return
}

function stringifyArguments(fieldNode: FieldNode | DirectiveNode): string {
  // FIXME https://github.com/graphql/graphql-js/issues/2203
  const args = /* c8 ignore next */ fieldNode.arguments ?? []

  const inputObjectWithArgs: ObjectValueNode = {
    kind: Kind.OBJECT,
    fields: args.map((argNode) => ({
      kind: Kind.OBJECT_FIELD,
      name: argNode.name,
      value: argNode.value,
    })),
  }
  return print(sortValueNode(inputObjectWithArgs))
}

function getStreamDirective(
  directives: ReadonlyArray<DirectiveNode>,
): DirectiveNode | undefined {
  return directives.find((directive) => directive.name.value === 'stream')
}

function sameStreams(
  directives1: ReadonlyArray<DirectiveNode>,
  directives2: ReadonlyArray<DirectiveNode>,
): boolean {
  const stream1 = getStreamDirective(directives1)
  const stream2 = getStreamDirective(directives2)
  if (!stream1 && !stream2) {
    // both fields do not have streams
    return true
  }
  if (stream1 && stream2) {
    // check if both fields have equivalent streams
    return stringifyArguments(stream1) === stringifyArguments(stream2)
  }
  // fields have a mix of stream and no stream
  return false
}

// Two types conflict if both types could not apply to a value simultaneously.
// Composite types are ignored as their individual field types will be compared
// later recursively. However List and Non-Null types must match.
function doTypesConflict(
  type1: GraphQLOutputType,
  type2: GraphQLOutputType,
): boolean {
  if (isListType(type1)) {
    return isListType(type2)
      ? doTypesConflict(type1.ofType, type2.ofType)
      : true
  }
  if (isListType(type2)) {
    return true
  }
  if (isNonNullType(type1)) {
    return isNonNullType(type2)
      ? doTypesConflict(type1.ofType, type2.ofType)
      : true
  }
  if (isNonNullType(type2)) {
    return true
  }
  if (isLeafType(type1) || isLeafType(type2)) {
    return type1 !== type2
  }
  return false
}

// Given a selection set, return the collection of fields (a mapping of response
// name to field nodes and definitions) as well as a list of fragment names
// referenced via fragment spreads.
function getFieldsAndFragmentNames(
  context: ValidationContext,
  cachedFieldsAndFragmentNames: Map<SelectionSetNode, FieldsAndFragmentNames>,
  parentType: Maybe<GraphQLNamedType>,
  selectionSet: SelectionSetNode,
): FieldsAndFragmentNames {
  const cached = cachedFieldsAndFragmentNames.get(selectionSet)
  if (cached) {
    return cached
  }
  const nodeAndDefs: NodeAndDefCollection = Object.create(null)
  const fragmentNames = new Set<string>()
  _collectFieldsAndFragmentNames(
    context,
    parentType,
    selectionSet,
    nodeAndDefs,
    fragmentNames,
  )
  const result = [nodeAndDefs, [...fragmentNames]] as const
  cachedFieldsAndFragmentNames.set(selectionSet, result)
  return result
}

// Given a reference to a fragment, return the represented collection of fields
// as well as a list of nested fragment names referenced via fragment spreads.
function getReferencedFieldsAndFragmentNames(
  context: ValidationContext,
  cachedFieldsAndFragmentNames: Map<SelectionSetNode, FieldsAndFragmentNames>,
  fragment: FragmentDefinitionNode,
) {
  // Short-circuit building a type from the node if possible.
  const cached = cachedFieldsAndFragmentNames.get(fragment.selectionSet)
  if (cached) {
    return cached
  }

  const fragmentType = typeFromAST(context.getSchema(), fragment.typeCondition)
  return getFieldsAndFragmentNames(
    context,
    cachedFieldsAndFragmentNames,
    fragmentType,
    fragment.selectionSet,
  )
}

function _collectFieldsAndFragmentNames(
  context: ValidationContext,
  parentType: Maybe<GraphQLNamedType>,
  selectionSet: SelectionSetNode,
  nodeAndDefs: NodeAndDefCollection,
  fragmentNames: Set<string>,
): void {
  for (const selection of selectionSet.selections) {
    switch (selection.kind) {
      case Kind.FIELD: {
        const fieldName = selection.name.value
        let fieldDef
        if (isObjectType(parentType) || isInterfaceType(parentType)) {
          fieldDef = parentType.getFields()[fieldName]
        }
        const responseName = selection.alias ? selection.alias.value : fieldName
        if (!nodeAndDefs[responseName]) {
          nodeAndDefs[responseName] = []
        }
        nodeAndDefs[responseName].push([parentType, selection, fieldDef])
        break
      }
      case Kind.FRAGMENT_SPREAD:
        fragmentNames.add(selection.name.value)
        break
      case Kind.INLINE_FRAGMENT: {
        const typeCondition = selection.typeCondition
        const inlineFragmentType = typeCondition
          ? typeFromAST(context.getSchema(), typeCondition)
          : parentType
        _collectFieldsAndFragmentNames(
          context,
          inlineFragmentType,
          selection.selectionSet,
          nodeAndDefs,
          fragmentNames,
        )
        break
      }
    }
  }
}

// Given a series of Conflicts which occurred between two sub-fields, generate
// a single Conflict.
function subfieldConflicts(
  conflicts: ReadonlyArray<Conflict>,
  responseName: string,
  node1: FieldNode,
  node2: FieldNode,
): Maybe<Conflict> {
  if (conflicts.length > 0) {
    return [
      [responseName, conflicts.map(([reason]) => reason)],
      [node1, ...conflicts.map(([, fields1]) => fields1).flat()],
      [node2, ...conflicts.map(([, , fields2]) => fields2).flat()],
    ]
  }
  return
}

/**
 * A way to keep track of pairs of things when the ordering of the pair does not matter.
 */
class PairSet {
  _data: Map<string, Map<string, boolean>>

  constructor() {
    this._data = new Map()
  }

  has(a: string, b: string, areMutuallyExclusive: boolean): boolean {
    const [key1, key2] = a < b ? [a, b] : [b, a]

    const result = this._data.get(key1)?.get(key2)
    if (result === undefined) {
      return false
    }

    // areMutuallyExclusive being false is a superset of being true, hence if
    // we want to know if this PairSet "has" these two with no exclusivity,
    // we have to ensure it was added as such.
    return areMutuallyExclusive ? true : areMutuallyExclusive === result
  }

  add(a: string, b: string, areMutuallyExclusive: boolean): void {
    const [key1, key2] = a < b ? [a, b] : [b, a]

    const map = this._data.get(key1)
    if (map === undefined) {
      this._data.set(key1, new Map([[key2, areMutuallyExclusive]]))
    } else {
      map.set(key2, areMutuallyExclusive)
    }
  }
}
