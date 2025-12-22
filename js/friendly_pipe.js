import { app } from "../../scripts/app.js";

// Helper function to find source through parent subgraph node
// Returns { node, slot } or null
function findSourceThroughParent(subgraphNode, inputSlotIndex, subgraph) {
    console.log("[FriendlyPipe] findSourceThroughParent called");
    console.log("[FriendlyPipe] subgraphNode:", subgraphNode);
    console.log("[FriendlyPipe] subgraphNode.inputs:", subgraphNode?.inputs);
    console.log("[FriendlyPipe] inputSlotIndex:", inputSlotIndex);
    
    if (!subgraphNode || !subgraphNode.inputs) return null;
    
    // The origin_slot from the link inside the subgraph should map to the parent's input
    const parentInput = subgraphNode.inputs[inputSlotIndex];
    console.log("[FriendlyPipe] parentInput:", parentInput);
    
    if (parentInput && parentInput.link) {
        const parentGraph = subgraphNode.graph || app.graph;
        const parentLink = parentGraph.links[parentInput.link];
        console.log("[FriendlyPipe] parentLink:", parentLink);
        
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
            console.log("[FriendlyPipe] Found source:", source, "slot:", parentLink.origin_slot);
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
    
    // Try various ways to get the parent subgraph node
    let parentNode = graph._subgraph_node || graph.parentNode || graph._parentNode;
    let parentGraph = parentNode?.graph || app.graph;
    
    // If we're in a subgraph, the graph might have a reference to its container
    if (!parentNode && graph._is_subgraph) {
        // Search main graph for subgraph nodes containing this graph
        for (const n of app.graph._nodes || []) {
            if (n.subgraph === graph) {
                parentNode = n;
                parentGraph = app.graph;
                break;
            }
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
            console.log("[FriendlyPipe] findOriginalSource: Found source node:", currentNode.type, currentNode.id);
            return currentNode;
        }
        
        // Handle Subgraph nodes - need to enter the subgraph and find the source connected to the output
        if (currentNode.subgraph) {
            console.log("[FriendlyPipe] findOriginalSource: Entering subgraph node, outputSlot:", currentSlot);
            const subgraph = currentNode.subgraph;
            const outputSlot = currentSlot;
            
            // Check if subgraph.outputs defines the output mappings (ComfyUI style)
            if (subgraph.outputs && subgraph.outputs[outputSlot]) {
                const outputDef = subgraph.outputs[outputSlot];
                console.log("[FriendlyPipe] findOriginalSource: outputDef:", outputDef);
                
                // SubgraphOutput has linkIds array containing internal link IDs
                const linkIds = outputDef.linkIds || outputDef.links || [];
                console.log("[FriendlyPipe] findOriginalSource: linkIds:", linkIds);
                
                if (linkIds.length > 0) {
                    const innerLinkId = linkIds[0]; // Take the first link
                    const innerLink = subgraph.links[innerLinkId];
                    console.log("[FriendlyPipe] findOriginalSource: inner link:", innerLink);
                    if (innerLink) {
                        const innerSource = subgraph.getNodeById(innerLink.origin_id);
                        console.log("[FriendlyPipe] findOriginalSource: inner source:", innerSource?.type, innerSource?.id);
                        if (innerSource) {
                            const result = findOriginalSource(innerSource, innerLink.origin_slot, depth + 1);
                            console.log("[FriendlyPipe] findOriginalSource: recursive result:", result?.type, result?.id);
                            if (result) return result;
                        }
                    }
                }
                
                // Also check for a single 'link' property
                if (outputDef.link !== undefined && outputDef.link !== null) {
                    const innerLink = subgraph.links[outputDef.link];
                    console.log("[FriendlyPipe] findOriginalSource: inner link from .link:", innerLink);
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
            console.log("[FriendlyPipe] findOriginalSource: No source found in subgraph");
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
    
    if (!node.outputs || !node.outputs[slotIndex] || !node.outputs[slotIndex].links) return;
    
    for (const linkId of node.outputs[slotIndex].links) {
        const link = graph.links[linkId];
        if (!link) continue;
        
        const targetNode = graph.getNodeById(link.target_id);
        if (!targetNode) continue;
        
        // Prevent infinite loops
        const nodeKey = `${targetNode.id}-${graph.id || 'main'}`;
        if (visited.has(nodeKey)) continue;
        visited.add(nodeKey);
        
        // If target has syncWithSource, call it
        if (targetNode.syncWithSource) {
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
    }
}

app.registerExtension({
    name: "Comfy.FriendlyPipe",
    
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "FriendlyPipeIn") {
            setupFriendlyPipeIn(nodeType, nodeData, app);
        }
        
        if (nodeData.name === "FriendlyPipeOut") {
            setupFriendlyPipeOut(nodeType, nodeData, app);
        }
        
        if (nodeData.name === "FriendlyPipeEdit") {
            setupFriendlyPipeEdit(nodeType, nodeData, app);
        }
    }
});

function setupFriendlyPipeIn(nodeType, nodeData, app) {
    const origOnNodeCreated = nodeType.prototype.onNodeCreated;
    
    nodeType.prototype.onNodeCreated = function() {
        if (origOnNodeCreated) {
            origOnNodeCreated.apply(this, arguments);
        }
        
        const node = this;
        
        // Initialize slot count, names, and types
        this.slotCount = 1;
        this.slotNames = { 1: "slot_1" };
        this.slotTypes = {};
        
        // Remove all inputs except the first one
        while (this.inputs && this.inputs.length > 1) {
            this.removeInput(this.inputs.length - 1);
        }
        
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
        
        if (!this.inputs) return;
        
        for (let i = 0; i < this.inputs.length; i++) {
            const input = this.inputs[i];
            if (input && input.link) {
                const link = app.graph.links[input.link];
                if (link) {
                    const sourceNode = app.graph.getNodeById(link.origin_id);
                    if (sourceNode && sourceNode.outputs && sourceNode.outputs[link.origin_slot]) {
                        const outputType = sourceNode.outputs[link.origin_slot].type;
                        this.slotTypes[i + 1] = outputType;
                    }
                }
            }
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
    
    nodeType.prototype.updateFromSource = function(slotCount, slotNames, slotTypes) {
        const node = this;
        
        // Update outputs to match source
        const targetCount = slotCount || 1;
        const names = slotNames || {};
        const types = slotTypes || {};
        
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
        this.updateSize();
        this.setDirtyCanvas(true, true);
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
        
        console.log("[FriendlyPipe] syncWithSource called on node", this.id);
        console.log("[FriendlyPipe] this.graph:", this.graph);
        console.log("[FriendlyPipe] this.inputs:", this.inputs);
        
        if (!this.inputs || !this.inputs[0] || !this.inputs[0].link) {
            console.log("[FriendlyPipe] No connection, resetting to default");
            // No connection, reset to default
            this.updateFromSource(1, {}, {});
            return;
        }
        
        const linkId = this.inputs[0].link;
        console.log("[FriendlyPipe] linkId:", linkId);
        
        const link = graph.links[linkId];
        console.log("[FriendlyPipe] link:", link);
        
        if (!link) {
            console.log("[FriendlyPipe] Link not found in graph.links");
            return;
        }
        
        let immediateSource = null;
        let originSlot = link.origin_slot;
        
        // Handle negative origin_id (subgraph input boundary)
        if (link.origin_id < 0) {
            console.log("[FriendlyPipe] Negative origin_id detected, this is a subgraph input");
            console.log("[FriendlyPipe] graph._subgraph_node:", graph._subgraph_node);
            console.log("[FriendlyPipe] graph.inputs:", graph.inputs);
            console.log("[FriendlyPipe] graph._inputs:", graph._inputs);
            console.log("[FriendlyPipe] graph.config:", graph.config);
            console.log("[FriendlyPipe] All graph keys:", Object.keys(graph));
            
            // In LiteGraph, the subgraph stores input info in graph.inputs array
            // The negative ID maps to the input: -1 = first input, -2 = second, etc.
            // But sometimes it's offset, so let's try multiple approaches
            
            const subgraphNode = graph._subgraph_node;
            
            // Also try to find parent through other means
            if (!subgraphNode) {
                console.log("[FriendlyPipe] No _subgraph_node, searching app.graph for parent...");
                // Search all graphs for a subgraph containing this graph
                for (const node of app.graph._nodes || []) {
                    if (node.subgraph === graph) {
                        console.log("[FriendlyPipe] Found parent node:", node);
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
                console.log("[FriendlyPipe] Trying graph.inputs array");
                // Find the input definition that matches our slot
                const inputDef = graph.inputs[link.origin_slot];
                console.log("[FriendlyPipe] inputDef:", inputDef);
            }
        } else {
            immediateSource = graph.getNodeById(link.origin_id);
        }
        
        console.log("[FriendlyPipe] immediateSource:", immediateSource);
        console.log("[FriendlyPipe] immediateSource.type:", immediateSource?.type);
        console.log("[FriendlyPipe] originSlot:", originSlot);
        
        if (!immediateSource) {
            console.log("[FriendlyPipe] No immediate source found");
            return;
        }
        
        // Traverse through reroute/subgraph nodes to find the original FriendlyPipeIn or FriendlyPipeEdit
        const sourceNode = findOriginalSource(immediateSource, originSlot);
        console.log("[FriendlyPipe] sourceNode from traversal:", sourceNode);
        
        // Use the found source or fall back to immediate source
        const effectiveSource = sourceNode || immediateSource;
        
        if (effectiveSource && effectiveSource.slotCount !== undefined) {
            console.log("[FriendlyPipe] Found source with slotCount:", effectiveSource.slotCount);
            
            // Check if this is a FriendlyPipeEdit (has getTotalSlotCount method)
            if (effectiveSource.getTotalSlotCount) {
                console.log("[FriendlyPipe] Source is FriendlyPipeEdit, getting combined slots");
                // Make sure source has latest types
                if (effectiveSource.updateSlotTypes) {
                    effectiveSource.updateSlotTypes();
                }
                this.updateFromSource(
                    effectiveSource.getTotalSlotCount(),
                    effectiveSource.getCombinedSlotNames(),
                    effectiveSource.getCombinedSlotTypes()
                );
            } else {
                // FriendlyPipeIn or other source
                if (effectiveSource.updateSlotTypes) {
                    effectiveSource.updateSlotTypes();
                }
                this.updateFromSource(
                    effectiveSource.slotCount, 
                    effectiveSource.slotNames || {},
                    effectiveSource.slotTypes || {}
                );
            }
        } else {
            console.log("[FriendlyPipe] No valid source found");
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
        
        if (o.slotCount !== undefined) {
            this.updateFromSource(o.slotCount, o.slotNames || {}, o.slotTypes || {});
        }
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
        this.slotCount = 1;
        this.slotNames = { 1: "slot_1" };
        this.slotTypes = {};
        
        // Track incoming pipe info
        this.incomingSlotCount = 0;
        this.incomingSlotNames = {};
        
        // Remove all optional inputs except the first one
        // Keep the pipe input (index 0) and first slot input (index 1)
        while (this.inputs && this.inputs.length > 2) {
            this.removeInput(this.inputs.length - 1);
        }
        
        // Rename first additional slot
        if (this.inputs && this.inputs.length > 1) {
            this.inputs[1].label = this.slotNames[1];
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
            // Update the input label (offset by 1 for pipe input)
            const inputIndex = slotNum; // slotNum maps directly since pipe is at 0
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
        
        // Traverse through reroute nodes to find the original pipe source
        const originalSource = findOriginalSource(sourceNode, originSlot);
        const effectiveSource = originalSource || sourceNode;
        
        // Get combined slot info from source (could be FriendlyPipeIn or another FriendlyPipeEdit)
        if (effectiveSource.slotCount !== undefined) {
            // For FriendlyPipeEdit, we need to get the combined count
            if (effectiveSource.getTotalSlotCount) {
                this.incomingSlotCount = effectiveSource.getTotalSlotCount();
                this.incomingSlotNames = effectiveSource.getCombinedSlotNames();
            } else {
                this.incomingSlotCount = effectiveSource.slotCount;
                this.incomingSlotNames = effectiveSource.slotNames || {};
            }
        }
        
        this.notifyConnectedOutputs();
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
    
    // Get combined slot types
    nodeType.prototype.getCombinedSlotTypes = function() {
        const combined = {};
        
        // Types from incoming pipe would be tracked by the FriendlyPipeIn
        // Our additional slot types
        for (let i = 1; i <= this.slotCount; i++) {
            const newIndex = this.incomingSlotCount + i;
            if (this.slotTypes[i]) {
                combined[newIndex] = this.slotTypes[i];
            }
        }
        
        return combined;
    };
    
    nodeType.prototype.updateSlotTypes = function() {
        this.slotTypes = {};
        
        if (!this.inputs) return;
        
        // Start from index 1 to skip the pipe input
        for (let i = 1; i < this.inputs.length; i++) {
            const input = this.inputs[i];
            if (input && input.link) {
                const link = app.graph.links[input.link];
                if (link) {
                    const sourceNode = app.graph.getNodeById(link.origin_id);
                    if (sourceNode && sourceNode.outputs && sourceNode.outputs[link.origin_slot]) {
                        const outputType = sourceNode.outputs[link.origin_slot].type;
                        this.slotTypes[i] = outputType; // i corresponds to slot number here
                    }
                }
            }
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
                
                // Add input if needed (offset by 1 for pipe input)
                if (!this.inputs || this.inputs.length < i + 1) {
                    this.addInput("slot_" + i, "*");
                }
                if (this.inputs && this.inputs[i]) {
                    this.inputs[i].label = name;
                }
                
                // Add name widget
                this.addSlotNameWidget(i);
            }
        }
        
        // Update all input labels
        if (this.inputs) {
            for (let i = 1; i < this.inputs.length; i++) {
                const slotNum = i;
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
        
        // Sync with source after configure
        setTimeout(() => {
            this.syncWithSource();
        }, 100);
    };
}
