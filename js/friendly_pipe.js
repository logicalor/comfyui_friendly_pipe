import { app } from "../../scripts/app.js";

// Default configuration
const defaultConfig = {
    debug: false,
};

// Try to load config, fall back to defaults if not found
let config = defaultConfig;
try {
    const configModule = await import("./config.js");
    config = { ...defaultConfig, ...configModule.config };
} catch (e) {
    // config.js doesn't exist, use defaults
}

// Debug logging helper
function debugLog(...args) {
    if (config.debug) {
        console.log("[FriendlyPipe]", ...args);
    }
}

// Helper function to find source through parent subgraph node
// Returns { node, slot } or null
function findSourceThroughParent(subgraphNode, inputSlotIndex, subgraph) {
    debugLog("findSourceThroughParent called");
    debugLog("subgraphNode:", subgraphNode);
    debugLog("subgraphNode.inputs:", subgraphNode?.inputs);
    debugLog("inputSlotIndex:", inputSlotIndex);
    
    if (!subgraphNode || !subgraphNode.inputs) return null;
    
    // The origin_slot from the link inside the subgraph should map to the parent's input
    const parentInput = subgraphNode.inputs[inputSlotIndex];
    debugLog("parentInput:", parentInput);
    
    if (parentInput && parentInput.link) {
        const parentGraph = subgraphNode.graph || app.graph;
        const parentLink = parentGraph.links[parentInput.link];
        debugLog("parentLink:", parentLink);
        
        if (parentLink) {
            // Recursively handle if parent is also in a subgraph
            if (parentLink.origin_id < 0) {
                // Parent connection also comes from a subgraph boundary
                const grandparentNode = parentGraph._subgraph_node;
                if (grandparentNode) {
                    return findSourceThroughParent(grandparentNode, parentLink.origin_slot, parentGraph);
                }
            }
            
            const source = parentGraph.getNodeById(parentLink.origin_id);
            debugLog("Found source:", source, "slot:", parentLink.origin_slot);
            return { node: source, slot: parentLink.origin_slot };
        }
    }
    
    return null;
}

// Helper function to check if a node is a pass-through type
function isPassThroughNode(node) {
    if (!node) return false;
    
    // Known reroute types
    if (node.type === "Reroute" || 
        node.type === "ReroutePrimitive" ||
        node.type === "PrimitiveNode") {
        return true;
    }
    
    // Subgraph input/output nodes (various possible type names)
    if (node.type === "graph/input" || 
        node.type === "graph/output" ||
        node.type === "GraphInput" ||
        node.type === "GraphOutput") {
        return true;
    }
    
    // Generic pass-through detection (1 input, 1 output, no custom slot handling)
    if (node.inputs && node.inputs.length === 1 && 
        node.outputs && node.outputs.length === 1 &&
        node.slotCount === undefined) {
        return true;
    }
    
    return false;
}

// Helper to find the parent subgraph node when inside a subgraph
function getParentSubgraphInfo(node) {
    const graph = node.graph;
    if (!graph) return null;
    
    debugLog("getParentSubgraphInfo for node:", node.type, node.id);
    debugLog("graph._subgraph_node:", graph._subgraph_node);
    debugLog("graph.parentNode:", graph.parentNode);
    
    // Try various ways to get the parent subgraph node
    let parentNode = graph._subgraph_node || graph.parentNode || graph._parentNode;
    let parentGraph = parentNode?.graph || app.graph;
    
    // If we're in a subgraph, the graph might have a reference to its container
    if (!parentNode) {
        // Search all graphs recursively for a subgraph node containing this graph
        const searchForParent = (searchGraph, depth = 0) => {
            if (depth > 10) return null;
            
            for (const n of searchGraph._nodes || []) {
                if (n.subgraph === graph) {
                    debugLog("Found parent node in graph at depth", depth, ":", n);
                    return { parentNode: n, parentGraph: searchGraph };
                }
                // If this node has a subgraph, search inside it too
                if (n.subgraph) {
                    const result = searchForParent(n.subgraph, depth + 1);
                    if (result) return result;
                }
            }
            return null;
        };
        
        const result = searchForParent(app.graph);
        if (result) {
            parentNode = result.parentNode;
            parentGraph = result.parentGraph;
        }
    }
    
    if (parentNode) {
        return { parentNode, parentGraph };
    }
    
    return null;
}

// Helper function to traverse backwards through reroute/forwarding nodes to find the original source
function findOriginalSource(node, slotIndex, depth = 0) {
    // Prevent infinite recursion
    if (depth > 50) return null;
    
    const visited = new Set();
    let currentNode = node;
    let currentSlot = slotIndex;
    
    while (currentNode) {
        const graph = currentNode.graph || app.graph;
        
        // Prevent infinite loops
        const nodeKey = `${currentNode.id}-${currentSlot}-${graph?.id || 'main'}`;
        if (visited.has(nodeKey)) break;
        visited.add(nodeKey);
        
        // Check if this node has the properties we're looking for (FriendlyPipeIn or FriendlyPipeEdit)
        if (currentNode.slotCount !== undefined && currentNode.slotNames !== undefined) {
            debugLog("findOriginalSource: Found source node:", currentNode.type, currentNode.id);
            return currentNode;
        }
        
        // Handle Subgraph nodes - need to enter the subgraph and find the source connected to the output
        if (currentNode.subgraph) {
            debugLog("findOriginalSource: Entering subgraph node, outputSlot:", currentSlot);
            const subgraph = currentNode.subgraph;
            const outputSlot = currentSlot;
            
            // Check if subgraph.outputs defines the output mappings (ComfyUI style)
            if (subgraph.outputs && subgraph.outputs[outputSlot]) {
                const outputDef = subgraph.outputs[outputSlot];
                debugLog("findOriginalSource: outputDef:", outputDef);
                
                // SubgraphOutput has linkIds array containing internal link IDs
                const linkIds = outputDef.linkIds || outputDef.links || [];
                debugLog("findOriginalSource: linkIds:", linkIds);
                
                if (linkIds.length > 0) {
                    const innerLinkId = linkIds[0]; // Take the first link
                    const innerLink = subgraph.links[innerLinkId];
                    debugLog("findOriginalSource: inner link:", innerLink);
                    if (innerLink) {
                        const innerSource = subgraph.getNodeById(innerLink.origin_id);
                        debugLog("findOriginalSource: inner source:", innerSource?.type, innerSource?.id);
                        if (innerSource) {
                            const result = findOriginalSource(innerSource, innerLink.origin_slot, depth + 1);
                            debugLog("findOriginalSource: recursive result:", result?.type, result?.id);
                            if (result) return result;
                        }
                    }
                }
                
                // Also check for a single 'link' property
                if (outputDef.link !== undefined && outputDef.link !== null) {
                    const innerLink = subgraph.links[outputDef.link];
                    debugLog("findOriginalSource: inner link from .link:", innerLink);
                    if (innerLink) {
                        const innerSource = subgraph.getNodeById(innerLink.origin_id);
                        if (innerSource) {
                            const result = findOriginalSource(innerSource, innerLink.origin_slot, depth + 1);
                            if (result) return result;
                        }
                    }
                }
            }
            
            // Fallback: search for graph/output nodes (LiteGraph style)
            const subgraphNodes = subgraph._nodes || [];
            for (const innerNode of subgraphNodes) {
                if (innerNode.type === "graph/output" || innerNode.type === "GraphOutput") {
                    const outputIndex = innerNode.properties?.slot_index ?? 
                                        innerNode.properties?.index ?? 
                                        innerNode.slot_index ?? 0;
                    if (outputIndex === outputSlot) {
                        const graphOutputInput = innerNode.inputs?.[0];
                        if (graphOutputInput && graphOutputInput.link) {
                            const innerLink = subgraph.links[graphOutputInput.link];
                            if (innerLink) {
                                const innerSource = subgraph.getNodeById(innerLink.origin_id);
                                if (innerSource) {
                                    const result = findOriginalSource(innerSource, innerLink.origin_slot, depth + 1);
                                    if (result) return result;
                                }
                            }
                        }
                        break;
                    }
                }
            }
            debugLog("findOriginalSource: No source found in subgraph");
            break;
        }
        
        // Handle graph/input nodes (subgraph boundary) - need to exit to parent graph
        if (currentNode.type === "graph/input" || currentNode.type === "GraphInput") {
            const parentInfo = getParentSubgraphInfo(currentNode);
            if (parentInfo) {
                const { parentNode, parentGraph } = parentInfo;
                // Find which input slot on parent corresponds to this graph/input
                const inputIndex = currentNode.properties?.slot_index ?? 
                                   currentNode.properties?.index ?? 
                                   currentNode.slot_index ?? 0;
                const parentInput = parentNode.inputs?.[inputIndex];
                if (parentInput && parentInput.link) {
                    const link = parentGraph.links[parentInput.link];
                    if (link) {
                        const sourceNode = parentGraph.getNodeById(link.origin_id);
                        if (sourceNode) {
                            // Recursively search from parent graph
                            const result = findOriginalSource(sourceNode, link.origin_slot, depth + 1);
                            if (result) return result;
                        }
                    }
                }
            }
            break;
        }
        
        // Check if this is a pass-through node
        if (isPassThroughNode(currentNode)) {
            const inputSlot = currentNode.inputs?.[0];
            if (inputSlot && inputSlot.link) {
                const link = graph.links[inputSlot.link];
                if (link) {
                    currentNode = graph.getNodeById(link.origin_id);
                    currentSlot = link.origin_slot;
                    continue;
                }
            }
        }
        
        // Check if this node has an input link we can follow (for non-passthrough nodes)
        const input = currentNode.inputs?.[currentSlot] || currentNode.inputs?.[0];
        if (input && input.link) {
            const link = graph.links[input.link];
            if (link) {
                currentNode = graph.getNodeById(link.origin_id);
                currentSlot = link.origin_slot;
                continue;
            }
        }
        
        // Not a pass-through or no more links to follow
        break;
    }
    
    return null;
}

// Helper function to traverse forwards through reroute/forwarding nodes to notify all connected outputs
function notifyDownstreamNodes(node, slotIndex, visited = new Set(), depth = 0) {
    // Prevent infinite recursion
    if (depth > 50) return;
    
    const graph = node.graph || app.graph;
    
    debugLog("notifyDownstreamNodes called:", {
        nodeType: node.type,
        nodeId: node.id,
        slotIndex,
        depth,
        hasOutputs: !!node.outputs,
        outputSlot: node.outputs?.[slotIndex],
        links: node.outputs?.[slotIndex]?.links
    });
    
    if (!node.outputs || !node.outputs[slotIndex] || !node.outputs[slotIndex].links) return;
    
    for (const linkId of node.outputs[slotIndex].links) {
        // Try to find the link in the current graph first, then fall back to app.graph
        let link = graph.links instanceof Map ? graph.links.get(linkId) : graph.links?.[linkId];
        if (!link && graph !== app.graph) {
            // Link might be in the parent/root graph for cross-subgraph connections
            link = app.graph.links instanceof Map ? app.graph.links.get(linkId) : app.graph.links?.[linkId];
        }
        debugLog("Processing linkId:", linkId, "link:", link);
        if (!link) continue;
        
        // Handle negative target_id (subgraph output boundary)
        if (link.target_id < 0) {
            debugLog("Negative target_id detected - subgraph output boundary");
            // This connection goes to a subgraph output
            // We need to find the parent subgraph node and notify nodes connected to its output
            const parentInfo = getParentSubgraphInfo(node);
            if (parentInfo) {
                const { parentNode, parentGraph } = parentInfo;
                // The target_slot on a subgraph output boundary maps to the parent's output slot
                // But we need to figure out which output slot on the parent corresponds to this
                const outputSlotOnParent = link.target_slot;
                debugLog("Found parent subgraph, notifying from output slot:", outputSlotOnParent);
                notifyDownstreamNodes(parentNode, outputSlotOnParent, visited, depth + 1);
            }
            continue;
        }
        
        // Try to find the target node in the current graph first, then app.graph
        let targetNode = graph.getNodeById(link.target_id);
        if (!targetNode && graph !== app.graph) {
            targetNode = app.graph.getNodeById(link.target_id);
        }
        debugLog("link.target_id:", link.target_id, "targetNode:", targetNode);
        if (!targetNode) continue;
        
        debugLog("Found target node:", {
            targetType: targetNode.type,
            targetId: targetNode.id,
            hasSyncWithSource: !!targetNode.syncWithSource
        });
        
        // Prevent infinite loops
        const nodeKey = `${targetNode.id}-${graph.id || 'main'}`;
        if (visited.has(nodeKey)) continue;
        visited.add(nodeKey);
        
        // If target has syncWithSource, call it
        if (targetNode.syncWithSource) {
            debugLog("Calling syncWithSource on", targetNode.type, targetNode.id);
            targetNode.syncWithSource();
        }
        
        // Handle graph/output nodes - exit subgraph and notify parent graph's downstream nodes
        if (targetNode.type === "graph/output" || targetNode.type === "GraphOutput") {
            const parentInfo = getParentSubgraphInfo(targetNode);
            if (parentInfo) {
                const { parentNode, parentGraph } = parentInfo;
                // Find which output slot on parent corresponds to this graph/output
                const outputIndex = targetNode.properties?.slot_index ?? 
                                    targetNode.properties?.index ?? 
                                    targetNode.slot_index ?? 0;
                // Notify downstream nodes connected to the parent subgraph's output
                notifyDownstreamNodes(parentNode, outputIndex, visited, depth + 1);
            }
        }
        
        // Handle Subgraph nodes - enter the subgraph and notify from graph/input
        if (targetNode.subgraph) {
            const subgraph = targetNode.subgraph;
            const targetInputSlot = link.target_slot;
            const subgraphNodes = subgraph._nodes || [];
            
            for (const innerNode of subgraphNodes) {
                // Find the graph/input that corresponds to this input slot
                if (innerNode.type === "graph/input" || innerNode.type === "GraphInput") {
                    const inputIndex = innerNode.properties?.slot_index ?? 
                                       innerNode.properties?.index ?? 
                                       innerNode.slot_index ?? 0;
                    if (inputIndex === targetInputSlot) {
                        notifyDownstreamNodes(innerNode, 0, visited, depth + 1);
                    }
                }
                // Also directly notify FriendlyPipeOut nodes inside
                if (innerNode.syncWithSource) {
                    innerNode.syncWithSource();
                }
            }
        }
        
        // If target is a pass-through, continue traversing
        if (isPassThroughNode(targetNode) && targetNode.outputs) {
            notifyDownstreamNodes(targetNode, 0, visited, depth + 1);
        }
        
        // If target is a FriendlyPipeEdit, continue propagating through it
        // (it has already been synced above, now notify its downstream nodes)
        if (targetNode.type === "FriendlyPipeEdit" && targetNode.outputs) {
            notifyDownstreamNodes(targetNode, 0, visited, depth + 1);
        }
    }
}

console.log("[FriendlyPipe] Extension loading...");

app.registerExtension({
    name: "Comfy.FriendlyPipe",
    
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "FriendlyPipeIn") {
            console.log("[FriendlyPipe] Setting up FriendlyPipeIn");
            setupFriendlyPipeIn(nodeType, nodeData, app);
        }
        
        if (nodeData.name === "FriendlyPipeOut") {
            console.log("[FriendlyPipe] Setting up FriendlyPipeOut");
            setupFriendlyPipeOut(nodeType, nodeData, app);
        }
        
        if (nodeData.name === "FriendlyPipeEdit") {
            console.log("[FriendlyPipe] Setting up FriendlyPipeEdit");
            setupFriendlyPipeEdit(nodeType, nodeData, app);
        }
    }
});

function setupFriendlyPipeIn(nodeType, nodeData, app) {
    const origOnNodeCreated = nodeType.prototype.onNodeCreated;
    
    nodeType.prototype.onNodeCreated = function() {
        console.log("[FriendlyPipe] FriendlyPipeIn onNodeCreated called");
        if (origOnNodeCreated) {
            origOnNodeCreated.apply(this, arguments);
        }
        
        const node = this;
        
        // Initialize slot count, names, types, and sources
        this.slotCount = 1;
        this.slotNames = { 1: "slot_1" };
        this.slotTypes = {};
        this.slotSources = {};
        
        console.log("[FriendlyPipe] Before removing inputs, count:", this.inputs?.length);
        // Remove all inputs except the first one
        while (this.inputs && this.inputs.length > 1) {
            this.removeInput(this.inputs.length - 1);
        }
        console.log("[FriendlyPipe] After removing inputs, count:", this.inputs?.length);
        
        // Rename first input
        if (this.inputs && this.inputs.length > 0) {
            this.inputs[0].label = this.slotNames[1];
        }
        
        // Add name widget for slot 1 first (above buttons)
        this.addSlotNameWidget(1);
        
        // Add control buttons
        const addWidget = this.addWidget("button", "➕ Add Slot", null, () => {
            if (node.slotCount < 80) {
                node.slotCount++;
                const defaultName = "slot_" + node.slotCount;
                node.slotNames[node.slotCount] = defaultName;
                
                // Add new input slot
                node.addInput("slot_" + node.slotCount, "*");
                if (node.inputs && node.inputs.length > 0) {
                    node.inputs[node.inputs.length - 1].label = defaultName;
                }
                
                // Add name widget for the new slot (will be inserted before buttons)
                node.addSlotNameWidget(node.slotCount);
                node.updateSize();
                node.notifyConnectedOutputs();
                node.setDirtyCanvas(true, true);
            }
        });
        addWidget.serialize = false;
        
        const removeWidget = this.addWidget("button", "➖ Remove Slot", null, () => {
            if (node.slotCount > 1) {
                // Remove the name widget
                node.removeSlotNameWidget(node.slotCount);
                
                // Remove the input slot
                node.removeInput(node.inputs.length - 1);
                
                delete node.slotNames[node.slotCount];
                node.slotCount--;
                node.updateSize();
                node.notifyConnectedOutputs();
                node.setDirtyCanvas(true, true);
            }
        });
        removeWidget.serialize = false;
        
        // Store button references so we can insert widgets before them
        this.addButton = addWidget;
        this.removeButton = removeWidget;
        
        this.updateSize();
    };
    
    nodeType.prototype.addSlotNameWidget = function(slotNum) {
        const node = this;
        const defaultName = node.slotNames[slotNum] || ("slot_" + slotNum);
        
        const nameWidget = this.addWidget("text", "Label " + slotNum, defaultName, (value) => {
            node.slotNames[slotNum] = value;
            // Update the input label
            const inputIndex = slotNum - 1;
            if (node.inputs && node.inputs[inputIndex]) {
                node.inputs[inputIndex].label = value;
            }
            node.notifyConnectedOutputs();
            node.setDirtyCanvas(true, true);
        });
        nameWidget.slotNum = slotNum;
        
        // Move the widget before the buttons if they exist
        if (this.widgets && this.addButton) {
            const widgetIndex = this.widgets.indexOf(nameWidget);
            const addButtonIndex = this.widgets.indexOf(this.addButton);
            if (widgetIndex > addButtonIndex && addButtonIndex >= 0) {
                // Remove from current position and insert before buttons
                this.widgets.splice(widgetIndex, 1);
                this.widgets.splice(addButtonIndex, 0, nameWidget);
            }
        }
    };
    
    nodeType.prototype.removeSlotNameWidget = function(slotNum) {
        if (this.widgets) {
            const widgetIndex = this.widgets.findIndex(w => w.slotNum === slotNum);
            if (widgetIndex >= 0) {
                this.widgets.splice(widgetIndex, 1);
            }
        }
    };
    
    nodeType.prototype.notifyConnectedOutputs = function() {
        // Find all nodes connected to our output and notify them (traversing through reroutes)
        if (!this.outputs || !this.outputs[0] || !this.outputs[0].links) return;
        
        notifyDownstreamNodes(this, 0, new Set([`${this.id}`]));
    };
    
    nodeType.prototype.updateSize = function() {
        this.setSize(this.computeSize());
    };
    
    // Handle connection changes to track types
    const origOnConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function(type, index, connected, linkInfo) {
        if (origOnConnectionsChange) {
            origOnConnectionsChange.apply(this, arguments);
        }
        
        // When an input connection changes, update the type
        if (type === 1) { // Input connection
            this.updateSlotTypes();
            this.notifyConnectedOutputs();
        }
    };
    
    nodeType.prototype.updateSlotTypes = function() {
        this.slotTypes = {};
        this.slotSources = {}; // Track source nodes for FRIENDLY_PIPE inputs
        
        if (!this.inputs) return;
        
        const graph = this.graph || app.graph;
        
        for (let i = 0; i < this.inputs.length; i++) {
            const input = this.inputs[i];
            if (input && input.link) {
                const link = graph.links[input.link];
                if (link) {
                    const sourceNode = graph.getNodeById(link.origin_id);
                    if (sourceNode && sourceNode.outputs && sourceNode.outputs[link.origin_slot]) {
                        const outputType = sourceNode.outputs[link.origin_slot].type;
                        this.slotTypes[i + 1] = outputType;
                        
                        // If this slot receives a FRIENDLY_PIPE, track its source
                        if (outputType === "FRIENDLY_PIPE") {
                            // Find the original source of this pipe
                            const pipeSource = findOriginalSource(sourceNode, link.origin_slot);
                            if (pipeSource) {
                                this.slotSources[i + 1] = pipeSource;
                            }
                        }
                    }
                }
            }
        }
    };
    
    // Get the source node for a specific slot (used by downstream FriendlyPipeOut)
    nodeType.prototype.getSlotSource = function(slotIndex) {
        return this.slotSources?.[slotIndex] || null;
    };
    
    // Handle serialization
    const origOnSerialize = nodeType.prototype.onSerialize;
    nodeType.prototype.onSerialize = function(o) {
        if (origOnSerialize) {
            origOnSerialize.apply(this, arguments);
        }
        o.slotCount = this.slotCount;
        o.slotNames = this.slotNames;
        o.slotTypes = this.slotTypes;
    };
    
    // Handle deserialization
    const origOnConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function(o) {
        if (origOnConfigure) {
            origOnConfigure.apply(this, arguments);
        }
        
        const node = this;
        
        if (o.slotNames) {
            this.slotNames = o.slotNames;
        }
        if (o.slotTypes) {
            this.slotTypes = o.slotTypes;
        }
        
        if (o.slotCount !== undefined && o.slotCount > 1) {
            // We already have 1 slot from onNodeCreated
            // Add the remaining slots
            for (let i = 2; i <= o.slotCount; i++) {
                this.slotCount = i;
                const name = this.slotNames[i] || ("slot_" + i);
                this.slotNames[i] = name;
                
                // Add input if needed
                if (!this.inputs || this.inputs.length < i) {
                    this.addInput("slot_" + i, "*");
                }
                if (this.inputs && this.inputs[i - 1]) {
                    this.inputs[i - 1].label = name;
                }
                
                // Add name widget
                this.addSlotNameWidget(i);
            }
        }
        
        // Update all input labels
        if (this.inputs) {
            for (let i = 0; i < this.inputs.length; i++) {
                const slotNum = i + 1;
                if (this.slotNames[slotNum]) {
                    this.inputs[i].label = this.slotNames[slotNum];
                }
            }
        }
        
        // Update name widget values
        if (this.widgets) {
            for (const widget of this.widgets) {
                if (widget.slotNum !== undefined && this.slotNames[widget.slotNum]) {
                    widget.value = this.slotNames[widget.slotNum];
                }
            }
        }
        
        this.updateSize();
    };
    
    // Override getExtraMenuOptions to update hidden values before execution
    const origGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function(canvas, options) {
        if (origGetExtraMenuOptions) {
            origGetExtraMenuOptions.apply(this, arguments);
        }
    };
    
    // Override onExecute or similar to pass slot info
    const origOnExecutionStart = nodeType.prototype.onExecutionStart;
    nodeType.prototype.onExecutionStart = function() {
        if (origOnExecutionStart) {
            origOnExecutionStart.apply(this, arguments);
        }
        // Update widgets for execution
        if (this.widgets) {
            const slotCountWidget = this.widgets.find(w => w.name === "slot_count");
            if (slotCountWidget) {
                slotCountWidget.value = this.slotCount;
            }
            const slotNamesWidget = this.widgets.find(w => w.name === "slot_names");
            if (slotNamesWidget) {
                slotNamesWidget.value = JSON.stringify(this.slotNames);
            }
        }
    };
}

function setupFriendlyPipeOut(nodeType, nodeData, app) {
    const origOnNodeCreated = nodeType.prototype.onNodeCreated;
    
    nodeType.prototype.onNodeCreated = function() {
        if (origOnNodeCreated) {
            origOnNodeCreated.apply(this, arguments);
        }
        
        const node = this;
        
        // Initialize
        this.slotCount = 1;
        this.slotNames = {};
        this.slotTypes = {};
        this.slotSources = {};
        
        // Remove all outputs except the first one
        while (this.outputs && this.outputs.length > 1) {
            this.removeOutput(this.outputs.length - 1);
        }
        
        // Rename first output
        if (this.outputs && this.outputs.length > 0) {
            this.outputs[0].label = "slot_1";
        }
        
        this.updateSize();
    };
    
    nodeType.prototype.updateSize = function() {
        this.setSize(this.computeSize());
    };
    
    nodeType.prototype.updateFromSource = function(slotCount, slotNames, slotTypes, slotSources) {
        const node = this;
        
        // Update outputs to match source
        const targetCount = slotCount || 1;
        const names = slotNames || {};
        const types = slotTypes || {};
        const sources = slotSources || {};
        
        // Add or remove outputs as needed
        while (this.outputs && this.outputs.length < targetCount) {
            const num = this.outputs.length + 1;
            const slotType = types[num] || "*";
            this.addOutput("slot_" + num, slotType);
        }
        while (this.outputs && this.outputs.length > targetCount) {
            this.removeOutput(this.outputs.length - 1);
        }
        
        // Update labels and types
        if (this.outputs) {
            for (let i = 0; i < this.outputs.length; i++) {
                const slotNum = i + 1;
                this.outputs[i].label = names[slotNum] || ("slot_" + slotNum);
                this.outputs[i].type = types[slotNum] || "*";
            }
        }
        
        this.slotCount = targetCount;
        this.slotNames = names;
        this.slotTypes = types;
        this.slotSources = sources;
        this.updateSize();
        this.setDirtyCanvas(true, true);
        
        // Notify any FriendlyPipeOut nodes connected to our output slots
        this.notifySlotConnections();
    };
    
    // Notify FriendlyPipeOut nodes connected to individual output slots
    nodeType.prototype.notifySlotConnections = function() {
        if (!this.outputs) return;
        
        const graph = this.graph || app.graph;
        
        for (let i = 0; i < this.outputs.length; i++) {
            const output = this.outputs[i];
            if (output.links) {
                for (const linkId of output.links) {
                    const link = graph.links instanceof Map ? graph.links.get(linkId) : graph.links?.[linkId];
                    if (link) {
                        const targetNode = graph.getNodeById(link.target_id);
                        if (targetNode && targetNode.syncWithSource) {
                            targetNode.syncWithSource();
                        }
                    }
                }
            }
        }
    };
    
    // Get the source node for a specific slot (used by downstream FriendlyPipeOut)
    nodeType.prototype.getSlotSource = function(slotIndex) {
        return this.slotSources?.[slotIndex] || null;
    };
    
    // Handle connection changes
    const origOnConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function(type, index, connected, linkInfo) {
        if (origOnConnectionsChange) {
            origOnConnectionsChange.apply(this, arguments);
        }
        
        // When input connection changes
        if (type === 1) {
            this.syncWithSource();
        }
    };
    
    nodeType.prototype.syncWithSource = function() {
        const graph = this.graph || app.graph;
        
        debugLog("syncWithSource called on node", this.id);
        debugLog("this.graph:", this.graph);
        debugLog("this.inputs:", this.inputs);
        
        if (!this.inputs || !this.inputs[0] || !this.inputs[0].link) {
            debugLog("No connection, resetting to default");
            // No connection, reset to default
            this.updateFromSource(1, {}, {});
            return;
        }
        
        const linkId = this.inputs[0].link;
        debugLog("linkId:", linkId);
        
        const link = graph.links[linkId];
        debugLog("link:", link);
        
        if (!link) {
            debugLog("Link not found in graph.links");
            return;
        }
        
        let immediateSource = null;
        let originSlot = link.origin_slot;
        
        // Handle negative origin_id (subgraph input boundary)
        if (link.origin_id < 0) {
            debugLog("Negative origin_id detected, this is a subgraph input");
            debugLog("graph._subgraph_node:", graph._subgraph_node);
            debugLog("graph.inputs:", graph.inputs);
            debugLog("graph._inputs:", graph._inputs);
            debugLog("graph.config:", graph.config);
            debugLog("All graph keys:", Object.keys(graph));
            
            // In LiteGraph, the subgraph stores input info in graph.inputs array
            // The negative ID maps to the input: -1 = first input, -2 = second, etc.
            // But sometimes it's offset, so let's try multiple approaches
            
            const subgraphNode = graph._subgraph_node;
            
            // Also try to find parent through other means
            if (!subgraphNode) {
                debugLog("No _subgraph_node, searching app.graph for parent...");
                // Search all graphs for a subgraph containing this graph
                for (const node of app.graph._nodes || []) {
                    if (node.subgraph === graph) {
                        debugLog("Found parent node:", node);
                        const result = findSourceThroughParent(node, link.origin_slot, graph);
                        if (result) {
                            immediateSource = result.node;
                            originSlot = result.slot;
                            break;
                        }
                    }
                }
            }
            
            if (subgraphNode && !immediateSource) {
                const result = findSourceThroughParent(subgraphNode, link.origin_slot, graph);
                if (result) {
                    immediateSource = result.node;
                    originSlot = result.slot;
                }
            }
            
            // Try using the graph.inputs array which defines subgraph inputs
            if (!immediateSource && graph.inputs) {
                debugLog("Trying graph.inputs array");
                // Find the input definition that matches our slot
                const inputDef = graph.inputs[link.origin_slot];
                debugLog("inputDef:", inputDef);
            }
        } else {
            immediateSource = graph.getNodeById(link.origin_id);
        }
        
        debugLog("immediateSource:", immediateSource);
        debugLog("immediateSource.type:", immediateSource?.type);
        debugLog("originSlot:", originSlot);
        
        if (!immediateSource) {
            debugLog("No immediate source found");
            return;
        }
        
        // Special case: if connected to a FriendlyPipeOut's output slot, check if that slot
        // contains a FRIENDLY_PIPE and trace back to its original source
        if (immediateSource.type === "FriendlyPipeOut") {
            // originSlot is 0-indexed, but our slotTypes/slotSources are 1-indexed
            const slotNum = originSlot + 1;
            debugLog("Connected to FriendlyPipeOut output slot", originSlot, "-> slotNum", slotNum);
            // This FriendlyPipeOut is outputting individual slots
            // Check if the slot type is FRIENDLY_PIPE
            const slotType = immediateSource.slotTypes?.[slotNum];
            debugLog("Slot type:", slotType);
            
            if (slotType === "FRIENDLY_PIPE") {
                // Need to find the original source of this pipe
                // First, find the FriendlyPipeIn that feeds this FriendlyPipeOut
                const pipeOutInput = immediateSource.inputs?.[0];
                if (pipeOutInput && pipeOutInput.link) {
                    // Get the graph where the immediateSource lives
                    const sourceGraph = immediateSource.graph || graph;
                    // Handle Map or object for links
                    const pipeOutLink = sourceGraph.links instanceof Map 
                        ? sourceGraph.links.get(pipeOutInput.link) 
                        : sourceGraph.links?.[pipeOutInput.link];
                    debugLog("pipeOutLink:", pipeOutLink);
                    if (pipeOutLink) {
                        let pipeInNode = null;
                        
                        // Handle negative origin_id (subgraph input boundary)
                        if (pipeOutLink.origin_id < 0) {
                            debugLog("FriendlyPipeOut's source is a subgraph input boundary");
                            // Need to trace through the subgraph boundary
                            const parentInfo = getParentSubgraphInfo(immediateSource);
                            if (parentInfo) {
                                const { parentNode, parentGraph } = parentInfo;
                                const parentInput = parentNode.inputs?.[pipeOutLink.origin_slot];
                                if (parentInput && parentInput.link) {
                                    const parentLink = parentGraph.links instanceof Map
                                        ? parentGraph.links.get(parentInput.link)
                                        : parentGraph.links?.[parentInput.link];
                                    if (parentLink) {
                                        pipeInNode = parentGraph.getNodeById(parentLink.origin_id);
                                        debugLog("Found pipeInNode through parent:", pipeInNode);
                                    }
                                }
                            }
                        } else {
                            pipeInNode = sourceGraph.getNodeById(pipeOutLink.origin_id);
                        }
                        
                        if (pipeInNode) {
                            // Find the original FriendlyPipeIn/Edit
                            const pipeSource = findOriginalSource(pipeInNode, pipeOutLink.origin_slot);
                            debugLog("pipeSource:", pipeSource);
                            if (pipeSource && pipeSource.getSlotSource) {
                                // Get the source for this specific slot
                                const slotSource = pipeSource.getSlotSource(slotNum);
                                debugLog("Found slot source:", slotSource);
                                if (slotSource) {
                                    if (slotSource.updateSlotTypes) {
                                        slotSource.updateSlotTypes();
                                    }
                                    if (slotSource.getTotalSlotCount) {
                                        this.updateFromSource(
                                            slotSource.getTotalSlotCount(),
                                            slotSource.getCombinedSlotNames(),
                                            slotSource.getCombinedSlotTypes(),
                                            slotSource.slotSources || {}
                                        );
                                    } else {
                                        this.updateFromSource(
                                            slotSource.slotCount,
                                            slotSource.slotNames || {},
                                            slotSource.slotTypes || {},
                                            slotSource.slotSources || {}
                                        );
                                    }
                                    return;
                                }
                            }
                        }
                    }
                }
            }
        }
        
        // Traverse through reroute/subgraph nodes to find the original FriendlyPipeIn or FriendlyPipeEdit
        const sourceNode = findOriginalSource(immediateSource, originSlot);
        debugLog("sourceNode from traversal:", sourceNode);
        
        // Use the found source or fall back to immediate source
        const effectiveSource = sourceNode || immediateSource;
        
        if (effectiveSource && effectiveSource.slotCount !== undefined) {
            debugLog("Found source with slotCount:", effectiveSource.slotCount);
            
            // Check if this is a FriendlyPipeEdit (has getTotalSlotCount method)
            if (effectiveSource.getTotalSlotCount) {
                debugLog("Source is FriendlyPipeEdit, getting combined slots");
                // Make sure source has latest types
                if (effectiveSource.updateSlotTypes) {
                    effectiveSource.updateSlotTypes();
                }
                this.updateFromSource(
                    effectiveSource.getTotalSlotCount(),
                    effectiveSource.getCombinedSlotNames(),
                    effectiveSource.getCombinedSlotTypes(),
                    effectiveSource.slotSources || {}
                );
            } else {
                // FriendlyPipeIn or other source
                if (effectiveSource.updateSlotTypes) {
                    effectiveSource.updateSlotTypes();
                }
                this.updateFromSource(
                    effectiveSource.slotCount, 
                    effectiveSource.slotNames || {},
                    effectiveSource.slotTypes || {},
                    effectiveSource.slotSources || {}
                );
            }
        } else {
            debugLog("No valid source found");
        }
    };
    
    // Handle serialization
    const origOnSerialize = nodeType.prototype.onSerialize;
    nodeType.prototype.onSerialize = function(o) {
        if (origOnSerialize) {
            origOnSerialize.apply(this, arguments);
        }
        o.slotCount = this.slotCount;
        o.slotNames = this.slotNames;
        o.slotTypes = this.slotTypes;
    };
    
    // Handle deserialization
    const origOnConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function(o) {
        if (origOnConfigure) {
            origOnConfigure.apply(this, arguments);
        }
        
        // Mark that we're loading from saved state
        this._loadedFromSave = true;
        this._savedSlotCount = o.slotCount;
        this._savedSlotNames = o.slotNames;
        this._savedSlotTypes = o.slotTypes;
        
        if (o.slotCount !== undefined) {
            this.updateFromSource(o.slotCount, o.slotNames || {}, o.slotTypes || {});
        }
        
        // Sync with source after a delay to ensure upstream nodes are configured
        // Use multiple attempts with increasing delays for robustness
        const node = this;
        const attemptSync = (attempt) => {
            if (attempt > 3) return;
            setTimeout(() => {
                node.syncWithSource();
            }, attempt * 200);
        };
        attemptSync(1);
        attemptSync(2);
        attemptSync(3);
    };
}

function setupFriendlyPipeEdit(nodeType, nodeData, app) {
    const origOnNodeCreated = nodeType.prototype.onNodeCreated;
    
    nodeType.prototype.onNodeCreated = function() {
        if (origOnNodeCreated) {
            origOnNodeCreated.apply(this, arguments);
        }
        
        const node = this;
        
        // Initialize slot count for additional slots (not including incoming pipe slots)
        // Start with 0 - adding new slots is optional
        this.slotCount = 0;
        this.slotNames = {};
        this.slotTypes = {};
        this.slotSources = {};
        
        // Track incoming pipe info
        this.incomingSlotCount = 0;
        this.incomingSlotNames = {};
        this.incomingSlotTypes = {};
        this.incomingSlotSources = {};
        
        // Track which incoming slots are exposed as inputs
        this.exposedIncomingSlots = {};
        
        // Remove all optional inputs - keep only the pipe input (index 0)
        // This removes the auto-generated inputs from Python's optional definitions
        while (this.inputs && this.inputs.length > 1) {
            this.removeInput(this.inputs.length - 1);
        }
        
        // Also do this after a short delay in case inputs are added after onNodeCreated
        setTimeout(() => {
            while (this.inputs && this.inputs.length > 1) {
                this.removeInput(this.inputs.length - 1);
            }
            this.updateSize();
            this.setDirtyCanvas(true, true);
        }, 10);
        
        // Add control buttons
        const addWidget = this.addWidget("button", "➕ Add Slot", null, () => {
            if (node.slotCount < 80) {
                node.slotCount++;
                const defaultName = "slot_" + node.slotCount;
                node.slotNames[node.slotCount] = defaultName;
                
                // Add new input slot at the end
                node.addInput("slot_" + node.slotCount, "*");
                if (node.inputs && node.inputs.length > 0) {
                    node.inputs[node.inputs.length - 1].label = defaultName;
                }
                
                // Add name widget for the new slot (will be inserted before buttons)
                node.addSlotNameWidget(node.slotCount);
                node.updateSize();
                node.notifyConnectedOutputs();
                node.setDirtyCanvas(true, true);
            }
        });
        addWidget.serialize = false;
        
        const removeWidget = this.addWidget("button", "➖ Remove Slot", null, () => {
            if (node.slotCount > 1) {
                // Remove the name widget
                node.removeSlotNameWidget(node.slotCount);
                
                // Remove the input slot (it's at the end, after exposed incoming slots)
                node.removeInput(node.inputs.length - 1);
                
                delete node.slotNames[node.slotCount];
                node.slotCount--;
                node.updateSize();
                node.notifyConnectedOutputs();
                node.setDirtyCanvas(true, true);
            }
        });
        removeWidget.serialize = false;
        
        // Store button references so we can insert widgets before them
        this.addButton = addWidget;
        this.removeButton = removeWidget;
        
        this.updateSize();
    };
    
    nodeType.prototype.addSlotNameWidget = function(slotNum) {
        const node = this;
        const defaultName = node.slotNames[slotNum] || ("slot_" + slotNum);
        
        const nameWidget = this.addWidget("text", "Label " + slotNum, defaultName, (value) => {
            node.slotNames[slotNum] = value;
            // Update the input label - account for pipe input and exposed incoming slots
            const inputIndex = 1 + node.incomingSlotCount + (slotNum - 1);
            if (node.inputs && node.inputs[inputIndex]) {
                node.inputs[inputIndex].label = value;
            }
            node.notifyConnectedOutputs();
            node.setDirtyCanvas(true, true);
        });
        nameWidget.slotNum = slotNum;
        
        // Move the widget before the buttons if they exist
        if (this.widgets && this.addButton) {
            const widgetIndex = this.widgets.indexOf(nameWidget);
            const addButtonIndex = this.widgets.indexOf(this.addButton);
            if (widgetIndex > addButtonIndex && addButtonIndex >= 0) {
                // Remove from current position and insert before buttons
                this.widgets.splice(widgetIndex, 1);
                this.widgets.splice(addButtonIndex, 0, nameWidget);
            }
        }
    };
    
    nodeType.prototype.removeSlotNameWidget = function(slotNum) {
        if (this.widgets) {
            const widgetIndex = this.widgets.findIndex(w => w.slotNum === slotNum);
            if (widgetIndex >= 0) {
                this.widgets.splice(widgetIndex, 1);
            }
        }
    };
    
    nodeType.prototype.notifyConnectedOutputs = function() {
        // Find all nodes connected to our output and notify them (traversing through reroutes)
        if (!this.outputs || !this.outputs[0] || !this.outputs[0].links) return;
        
        notifyDownstreamNodes(this, 0, new Set([`${this.id}`]));
    };
    
    nodeType.prototype.updateSize = function() {
        this.setSize(this.computeSize());
    };
    
    // Handle connection changes to sync with incoming pipe
    const origOnConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function(type, index, connected, linkInfo) {
        if (origOnConnectionsChange) {
            origOnConnectionsChange.apply(this, arguments);
        }
        
        // When pipe input (index 0) connection changes, sync with source
        if (type === 1 && index === 0) {
            this.syncWithSource();
        }
        
        // When any input connection changes, update types and notify downstream
        if (type === 1) {
            this.updateSlotTypes();
            this.notifyConnectedOutputs();
        }
    };
    
    nodeType.prototype.syncWithSource = function() {
        const graph = this.graph || app.graph;
        
        if (!this.inputs || !this.inputs[0] || !this.inputs[0].link) {
            // No pipe connection, reset incoming info
            this.incomingSlotCount = 0;
            this.incomingSlotNames = {};
            this.incomingSlotTypes = {};
            this.incomingSlotSources = {};
            // Remove exposed incoming slot inputs
            this.updateExposedIncomingSlots();
            this.notifyConnectedOutputs();
            return;
        }
        
        const linkId = this.inputs[0].link;
        const link = graph.links[linkId];
        
        if (!link) return;
        
        let sourceNode = null;
        let originSlot = link.origin_slot;
        
        // Handle negative origin_id (subgraph input boundary)
        if (link.origin_id < 0) {
            const subgraphNode = graph._subgraph_node;
            if (subgraphNode) {
                const result = findSourceThroughParent(subgraphNode, link.origin_slot, graph);
                if (result) {
                    sourceNode = result.node;
                    originSlot = result.slot;
                }
            } else {
                // Search for parent subgraph node
                for (const node of app.graph._nodes || []) {
                    if (node.subgraph === graph) {
                        const result = findSourceThroughParent(node, link.origin_slot, graph);
                        if (result) {
                            sourceNode = result.node;
                            originSlot = result.slot;
                        }
                        break;
                    }
                }
            }
        } else {
            sourceNode = graph.getNodeById(link.origin_id);
        }
        
        if (!sourceNode) return;
        
        // Special case: if connected to a FriendlyPipeOut's output slot, check if that slot
        // contains a FRIENDLY_PIPE and trace back to its original source
        if (sourceNode.type === "FriendlyPipeOut") {
            // originSlot is 0-indexed, but slotTypes/slotSources are 1-indexed
            const slotNum = originSlot + 1;
            debugLog("FriendlyPipeEdit connected to FriendlyPipeOut output slot", originSlot, "-> slotNum", slotNum);
            
            const slotType = sourceNode.slotTypes?.[slotNum];
            debugLog("Slot type:", slotType);
            
            if (slotType === "FRIENDLY_PIPE") {
                // Need to find the original source of this nested pipe
                const pipeOutInput = sourceNode.inputs?.[0];
                if (pipeOutInput && pipeOutInput.link) {
                    const sourceGraph = sourceNode.graph || graph;
                    const pipeOutLink = sourceGraph.links instanceof Map 
                        ? sourceGraph.links.get(pipeOutInput.link) 
                        : sourceGraph.links?.[pipeOutInput.link];
                    
                    if (pipeOutLink) {
                        let pipeInNode = null;
                        
                        // Handle negative origin_id (subgraph input boundary)
                        if (pipeOutLink.origin_id < 0) {
                            const parentInfo = getParentSubgraphInfo(sourceNode);
                            if (parentInfo) {
                                const { parentNode, parentGraph } = parentInfo;
                                const parentInput = parentNode.inputs?.[pipeOutLink.origin_slot];
                                if (parentInput && parentInput.link) {
                                    const parentLink = parentGraph.links instanceof Map
                                        ? parentGraph.links.get(parentInput.link)
                                        : parentGraph.links?.[parentInput.link];
                                    if (parentLink) {
                                        pipeInNode = parentGraph.getNodeById(parentLink.origin_id);
                                    }
                                }
                            }
                        } else {
                            pipeInNode = sourceGraph.getNodeById(pipeOutLink.origin_id);
                        }
                        
                        if (pipeInNode) {
                            const pipeSource = findOriginalSource(pipeInNode, pipeOutLink.origin_slot);
                            debugLog("pipeSource for nested pipe:", pipeSource);
                            
                            if (pipeSource && pipeSource.getSlotSource) {
                                const slotSource = pipeSource.getSlotSource(slotNum);
                                debugLog("Found slot source for nested pipe:", slotSource);
                                
                                if (slotSource) {
                                    if (slotSource.updateSlotTypes) {
                                        slotSource.updateSlotTypes();
                                    }
                                    if (slotSource.getTotalSlotCount) {
                                        this.incomingSlotCount = slotSource.getTotalSlotCount();
                                        this.incomingSlotNames = slotSource.getCombinedSlotNames();
                                        this.incomingSlotTypes = slotSource.getCombinedSlotTypes();
                                        this.incomingSlotSources = slotSource.getCombinedSlotSources ? slotSource.getCombinedSlotSources() : {};
                                    } else {
                                        this.incomingSlotCount = slotSource.slotCount;
                                        this.incomingSlotNames = slotSource.slotNames || {};
                                        this.incomingSlotTypes = slotSource.slotTypes || {};
                                        this.incomingSlotSources = slotSource.slotSources || {};
                                    }
                                    
                                    // Update exposed incoming slot inputs
                                    this.updateExposedIncomingSlots();
                                    this.notifyConnectedOutputs();
                                    return;
                                }
                            }
                        }
                    }
                }
            }
        }
        
        // Traverse through reroute nodes to find the original pipe source
        const originalSource = findOriginalSource(sourceNode, originSlot);
        const effectiveSource = originalSource || sourceNode;
        
        // Get combined slot info from source (could be FriendlyPipeIn or another FriendlyPipeEdit)
        if (effectiveSource.slotCount !== undefined) {
            // For FriendlyPipeEdit, we need to get the combined count
            if (effectiveSource.getTotalSlotCount) {
                this.incomingSlotCount = effectiveSource.getTotalSlotCount();
                this.incomingSlotNames = effectiveSource.getCombinedSlotNames();
                this.incomingSlotTypes = effectiveSource.getCombinedSlotTypes();
                this.incomingSlotSources = effectiveSource.getCombinedSlotSources ? effectiveSource.getCombinedSlotSources() : {};
            } else {
                this.incomingSlotCount = effectiveSource.slotCount;
                this.incomingSlotNames = effectiveSource.slotNames || {};
                // Make sure source has latest types
                if (effectiveSource.updateSlotTypes) {
                    effectiveSource.updateSlotTypes();
                }
                this.incomingSlotTypes = effectiveSource.slotTypes || {};
                this.incomingSlotSources = effectiveSource.slotSources || {};
            }
        }
        
        // Update exposed incoming slot inputs
        this.updateExposedIncomingSlots();
        
        this.notifyConnectedOutputs();
    };
    
    // Update the exposed incoming slot inputs based on current incoming pipe slots
    nodeType.prototype.updateExposedIncomingSlots = function() {
        const node = this;
        
        // Calculate expected input structure:
        // Index 0: pipe input
        // Index 1 to incomingSlotCount: exposed incoming slots (named incoming_slot_1, etc.)
        // Index incomingSlotCount+1 to end: additional new slots (named slot_1, etc.)
        
        const expectedExposedCount = this.incomingSlotCount;
        const currentExposedCount = Object.keys(this.exposedIncomingSlots || {}).length;
        
        // First, preserve connections on additional slots by tracking them
        const additionalSlotConnections = {};
        const additionalStartIndex = 1 + currentExposedCount;
        for (let i = 0; i < this.slotCount; i++) {
            const inputIndex = additionalStartIndex + i;
            if (this.inputs && this.inputs[inputIndex] && this.inputs[inputIndex].link) {
                additionalSlotConnections[i + 1] = this.inputs[inputIndex].link;
            }
        }
        
        // Remove all inputs except pipe input (index 0)
        while (this.inputs && this.inputs.length > 1) {
            this.removeInput(this.inputs.length - 1);
        }
        
        // Add exposed incoming slot inputs
        // These have names like "incoming_slot_1" for Python, but display labels from incoming pipe
        this.exposedIncomingSlots = {};
        for (let i = 1; i <= expectedExposedCount; i++) {
            const displayName = this.incomingSlotNames[i] || ("slot_" + i);
            const type = this.incomingSlotTypes[i] || "*";
            // Name must match Python parameter: incoming_slot_N
            this.addInput("incoming_slot_" + i, type);
            this.exposedIncomingSlots[i] = true;
            // Set display label to the incoming slot's name
            if (this.inputs[i]) {
                this.inputs[i].label = displayName;
                this.inputs[i].isExposedIncoming = true;
            }
        }
        
        // Re-add additional new slot inputs
        // These have names like "slot_1" for Python
        for (let i = 1; i <= this.slotCount; i++) {
            const displayName = this.slotNames[i] || ("slot_" + i);
            // Name must match Python parameter: slot_N
            this.addInput("slot_" + i, "*");
            const inputIndex = expectedExposedCount + i;
            if (this.inputs[inputIndex]) {
                this.inputs[inputIndex].label = displayName;
            }
        }
        
        this.updateSize();
        this.setDirtyCanvas(true, true);
    };
    
    // Get the input index for an additional slot (accounting for exposed incoming slots)
    nodeType.prototype.getAdditionalSlotInputIndex = function(slotNum) {
        return 1 + this.incomingSlotCount + (slotNum - 1);
    };
    
    // Get total slot count (incoming + our additional slots)
    nodeType.prototype.getTotalSlotCount = function() {
        return this.incomingSlotCount + this.slotCount;
    };
    
    // Get combined slot names (incoming names + our additional names with offset indices)
    nodeType.prototype.getCombinedSlotNames = function() {
        const combined = {};
        
        // Copy incoming slot names
        for (const [key, value] of Object.entries(this.incomingSlotNames)) {
            combined[key] = value;
        }
        
        // Add our slots with offset indices
        for (let i = 1; i <= this.slotCount; i++) {
            const newIndex = this.incomingSlotCount + i;
            combined[newIndex] = this.slotNames[i] || ("slot_" + i);
        }
        
        return combined;
    };
    
    // Get combined slot sources (incoming sources + our additional sources with offset indices)
    nodeType.prototype.getCombinedSlotSources = function() {
        const combined = {};
        
        // Copy incoming slot sources from upstream pipe
        if (this.incomingSlotSources) {
            for (const [key, value] of Object.entries(this.incomingSlotSources)) {
                combined[key] = value;
            }
        }
        
        // Add our additional slot sources with offset indices
        for (let i = 1; i <= this.slotCount; i++) {
            const newIndex = this.incomingSlotCount + i;
            if (this.slotSources[i]) {
                combined[newIndex] = this.slotSources[i];
            }
        }
        
        return combined;
    };
    
    // Get the source node for a specific slot (used by downstream FriendlyPipeOut)
    nodeType.prototype.getSlotSource = function(slotIndex) {
        // Check if it's an incoming slot or one of our additional slots
        if (slotIndex <= this.incomingSlotCount) {
            return this.incomingSlotSources?.[slotIndex] || null;
        } else {
            const ourSlotIndex = slotIndex - this.incomingSlotCount;
            return this.slotSources?.[ourSlotIndex] || null;
        }
    };
    
    nodeType.prototype.updateSlotTypes = function() {
        this.slotTypes = {};
        this.slotSources = {};
        
        // Also track updates to incoming slot types from exposed inputs
        this.incomingSlotUpdates = {};
        
        if (!this.inputs) return;
        
        const graph = this.graph || app.graph;
        
        // Process exposed incoming slot inputs (indices 1 to incomingSlotCount)
        for (let i = 1; i <= this.incomingSlotCount; i++) {
            const input = this.inputs[i];
            if (input && input.link) {
                const link = graph.links instanceof Map ? graph.links.get(input.link) : graph.links?.[input.link];
                if (link) {
                    const sourceNode = graph.getNodeById(link.origin_id);
                    if (sourceNode && sourceNode.outputs && sourceNode.outputs[link.origin_slot]) {
                        const outputType = sourceNode.outputs[link.origin_slot].type;
                        // Track that this incoming slot has an override connection
                        this.incomingSlotUpdates[i] = {
                            type: outputType,
                            sourceNode: sourceNode,
                            sourceSlot: link.origin_slot
                        };
                        
                        // If this slot receives a FRIENDLY_PIPE, track its source
                        if (outputType === "FRIENDLY_PIPE") {
                            const pipeSource = findOriginalSource(sourceNode, link.origin_slot);
                            if (pipeSource) {
                                this.incomingSlotSources[i] = pipeSource;
                            }
                        }
                    }
                }
            }
        }
        
        // Process additional slot inputs (indices incomingSlotCount+1 to end)
        const additionalStartIndex = 1 + this.incomingSlotCount;
        for (let i = 1; i <= this.slotCount; i++) {
            const inputIndex = additionalStartIndex + (i - 1);
            const input = this.inputs[inputIndex];
            if (input && input.link) {
                const link = graph.links instanceof Map ? graph.links.get(input.link) : graph.links?.[input.link];
                if (link) {
                    const sourceNode = graph.getNodeById(link.origin_id);
                    if (sourceNode && sourceNode.outputs && sourceNode.outputs[link.origin_slot]) {
                        const outputType = sourceNode.outputs[link.origin_slot].type;
                        this.slotTypes[i] = outputType;
                        
                        // If this slot receives a FRIENDLY_PIPE, track its source
                        if (outputType === "FRIENDLY_PIPE") {
                            const pipeSource = findOriginalSource(sourceNode, link.origin_slot);
                            if (pipeSource) {
                                this.slotSources[i] = pipeSource;
                            }
                        }
                    }
                }
            }
        }
    };
    
    // Get combined slot types (including overrides from exposed incoming slot connections)
    nodeType.prototype.getCombinedSlotTypes = function() {
        // Make sure our slot types are up to date
        this.updateSlotTypes();
        
        const combined = {};
        
        // Copy incoming slot types from upstream pipe
        if (this.incomingSlotTypes) {
            for (const [key, value] of Object.entries(this.incomingSlotTypes)) {
                combined[key] = value;
            }
        }
        
        // Override with types from exposed incoming slot connections
        if (this.incomingSlotUpdates) {
            for (const [key, update] of Object.entries(this.incomingSlotUpdates)) {
                combined[key] = update.type;
            }
        }
        
        // Add our additional slot types with offset indices
        for (let i = 1; i <= this.slotCount; i++) {
            const newIndex = this.incomingSlotCount + i;
            if (this.slotTypes[i]) {
                combined[newIndex] = this.slotTypes[i];
            }
        }
        
        return combined;
    };
    
    // Handle serialization
    const origOnSerialize = nodeType.prototype.onSerialize;
    nodeType.prototype.onSerialize = function(o) {
        if (origOnSerialize) {
            origOnSerialize.apply(this, arguments);
        }
        o.slotCount = this.slotCount;
        o.slotNames = this.slotNames;
        o.slotTypes = this.slotTypes;
        o.incomingSlotCount = this.incomingSlotCount;
        o.exposedIncomingSlots = this.exposedIncomingSlots;
    };
    
    // Handle deserialization
    const origOnConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function(o) {
        if (origOnConfigure) {
            origOnConfigure.apply(this, arguments);
        }
        
        const node = this;
        
        if (o.slotNames) {
            this.slotNames = o.slotNames;
        }
        if (o.slotTypes) {
            this.slotTypes = o.slotTypes;
        }
        if (o.incomingSlotCount !== undefined) {
            this.incomingSlotCount = o.incomingSlotCount;
        }
        if (o.exposedIncomingSlots) {
            this.exposedIncomingSlots = o.exposedIncomingSlots;
        }
        
        if (o.slotCount !== undefined && o.slotCount > 0) {
            // We start with 0 slots from onNodeCreated
            // Add all the slots
            for (let i = 1; i <= o.slotCount; i++) {
                this.slotCount = i;
                const name = this.slotNames[i] || ("slot_" + i);
                this.slotNames[i] = name;
                
                // Add name widget
                this.addSlotNameWidget(i);
            }
        }
        
        // Update name widget values
        if (this.widgets) {
            for (const widget of this.widgets) {
                if (widget.slotNum !== undefined && this.slotNames[widget.slotNum]) {
                    widget.value = this.slotNames[widget.slotNum];
                }
            }
        }
        
        this.updateSize();
        
        // Sync with source after configure - use multiple attempts for robustness
        const node = this;
        const attemptSync = (attempt) => {
            if (attempt > 3) return;
            setTimeout(() => {
                node.syncWithSource();
            }, attempt * 200);
        };
        attemptSync(1);
        attemptSync(2);
        attemptSync(3);
    };
    
    // Override onExecutionStart to pass slot info to Python backend
    const origOnExecutionStart = nodeType.prototype.onExecutionStart;
    nodeType.prototype.onExecutionStart = function() {
        if (origOnExecutionStart) {
            origOnExecutionStart.apply(this, arguments);
        }
        // Update widgets for execution
        if (this.widgets) {
            const slotCountWidget = this.widgets.find(w => w.name === "slot_count");
            if (slotCountWidget) {
                slotCountWidget.value = this.slotCount;
            }
            const slotNamesWidget = this.widgets.find(w => w.name === "slot_names");
            if (slotNamesWidget) {
                slotNamesWidget.value = JSON.stringify(this.slotNames);
            }
            const incomingSlotCountWidget = this.widgets.find(w => w.name === "incoming_slot_count");
            if (incomingSlotCountWidget) {
                incomingSlotCountWidget.value = this.incomingSlotCount;
            }
        }
    };
}
