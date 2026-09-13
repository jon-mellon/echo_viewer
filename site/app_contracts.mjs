// @ts-check

/** @typedef {string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }} JsonValue */

/**
 * @typedef {Object} Group
 * @property {string} group_id
 * @property {string} [label]
 * @property {string[]} variable_ids
 * @property {string[]} [seed_variable_ids]
 * @property {string[]} [excluded_nearby_variable_ids]
 * @property {Record<string, JsonValue>} [boundary_geometry]
 * @property {string} [notes]
 * @property {string | null} [type]
 * @property {string} [created_at]
 * @property {string} [updated_at]
 * @property {string} [source_grouping_set_id]
 * @property {string} [source_group_id]
 * @property {number} [similarity_coherence]
 * @property {JsonValue} [provenance]
 */

/**
 * @typedef {Object} ManualEdge
 * @property {string} edge_id
 * @property {string} source_group_id
 * @property {string} target_group_id
 * @property {string} [direction]
 * @property {boolean} [deleted]
 */

/**
 * @typedef {Object} LinkDecision
 * @property {string} [display_status]
 * @property {string} [direction]
 * @property {string} [reason]
 */

/**
 * Mutable domain state used by project operations. Unlike SerializedProjectPayload,
 * it contains normalized collections and is not itself a persistence envelope.
 * @typedef {Object} Project
 * @property {string} project_id
 * @property {string} active_grouping_set_id
 * @property {string} iv_group_id
 * @property {string} dv_group_id
 * @property {Group[]} groups
 * @property {JsonValue[]} links
 * @property {JsonValue[]} decisions
 * @property {Record<string, JsonValue>} filters
 * @property {JsonValue[]} grouping_imports
 * @property {JsonValue[]} grouping_exports
 * @property {JsonValue[]} carve_outs
 * @property {Record<string, LinkDecision>} link_decisions
 * @property {ManualEdge[]} manual_edges
 * @property {JsonValue[]} rejected_variables
 * @property {string[]} [restored_variable_ids]
 * @property {JsonValue | null} publication
 */

/**
 * JSON-safe persistence envelope. Set and Map values from DagAppState must be
 * converted to arrays/records before crossing this boundary.
 * @typedef {Object} SerializedProjectFields
 * @property {typeof PROJECT_FORMAT_VERSION} schema_version
 * @property {string | null} [selectedUoa]
 * @property {boolean} [uoaFilterEnabled]
 * @property {string} [phase]
 * @property {string} [workflowMode]
 * @property {"iv" | "dv" | null} [changingAnchorSide]
 * @property {string} [variableLayoutSource]
 * @property {"auto" | "hierarchical" | "organic"} [dagLayoutMode]
 * @property {{iv?: string[], dv?: string[]}} [seeds]
 * @property {JsonValue | null} [definitionDraft]
 * @property {string[]} [undoHistory]
 * @property {number} [undoPointer]
 * @property {JsonValue[]} [actionLog]
 */

/** @typedef {Partial<Project> & SerializedProjectFields} SerializedProjectPayload */

/**
 * @typedef {Object} AggregatedLink
 * @property {string} edge_id
 * @property {string} group_a
 * @property {string} group_b
 * @property {boolean} is_target_relation
 * @property {string} target_direction
 * @property {"mapping_derived" | "user_manual" | "mapping_and_manual"} edge_source
 * @property {boolean} is_manual
 * @property {string[]} manual_edge_ids
 * @property {boolean} mapping_a_to_b_exists
 * @property {boolean} mapping_b_to_a_exists
 * @property {boolean} manual_a_to_b_exists
 * @property {boolean} manual_b_to_a_exists
 * @property {"A_TO_B" | "B_TO_A" | "BIDIRECTIONAL" | "NO_MAPPING_LINK"} direction_type
 * @property {string[]} a_to_b_raw_link_ids
 * @property {string[]} b_to_a_raw_link_ids
 * @property {string[]} a_to_b_paper_table_keys
 * @property {string[]} b_to_a_paper_table_keys
 * @property {string} display_status
 * @property {LinkDecision | null} user_decision
 */

/**
 * @typedef {Object} GroupingSchema
 * @property {string} schema_version
 * @property {string} grouping_set_id
 * @property {Group[]} groups
 * @property {string} [label]
 * @property {string} [description]
 * @property {string} [membership_unit]
 * @property {JsonValue[]} [rejected_variables]
 * @property {Record<string, JsonValue>} [cache_compatibility]
 * @property {Record<string, JsonValue>} [built_against]
 * @property {Record<string, JsonValue>} [migration_provenance]
 */

/**
 * @typedef {Object} EvidenceManifestFile
 * @property {string} url
 * @property {string} [format]
 * @property {string} [sha256]
 * @property {number} [rows]
 */

/**
 * @typedef {Object} EvidenceManifest
 * @property {string} schema_version
 * @property {Record<string, EvidenceManifestFile>} files
 * @property {string} [generated_at]
 * @property {string} [default_grouping_set_id]
 * @property {Record<string, JsonValue>} [cache_compatibility]
 */

/**
 * @typedef {Object} DagAppState
 * @property {string} interfaceMode
 * @property {EvidenceManifest | null} data
 * @property {JsonValue[]} variables
 * @property {Map<string, JsonValue>} variableById
 * @property {Map<string, string>} clusterOf
 * @property {Map<string, string[]>} clusterMembers
 * @property {JsonValue[]} rawLinks
 * @property {Map<string, JsonValue>} rawLinksById
 * @property {Map<string, string[]>} linkLookup
 * @property {Map<string, JsonValue>} similarityEdgeMap
 * @property {Project | null} project
 * @property {{iv: Set<string>, dv: Set<string>}} seeds
 * @property {AggregatedLink[]} visibleLinks
 * @property {string | null} selectedUoa
 * @property {string} phase
 * @property {string} workflowMode
 * @property {Set<string>} selectedVariableIds
 * @property {Record<string, unknown>} map
 */

export const GROUPING_FORMAT_VERSION = "groupings-v2";
export const GROUPING_MEMBERSHIP_UNIT = "canonical_variable";
export const PROJECT_FORMAT_VERSION = "dag-builder-project-v1";
export const WORKING_MAP_FORMAT_VERSION = "working-causal-map-v1";
