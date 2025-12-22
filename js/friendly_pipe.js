import { app } from "../../scripts/app.js";

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
        
        // Check if this node has the properties we're looking for (FriendlyPipeIn or FriendlyPipeOut)
        if (currentNode.slotCount !== undefined && currentNode.slotNames !== undefined) {
            return currentNode;
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
            // The input slot index is encoded in the negative ID: -1 = slot 0, -10 = slot 9, etc.
            // Or it could be stored differently - let's find the parent subgraph
            const subgraphNode = graph._subgraph_node;
            console.log("[FriendlyPipe] subgraphNode:", subgraphNode);
            
            if (subgraphNode) {
                // Find which input slot this corresponds to
                // In LiteGraph, negative IDs map to input slots: -1 is first input, -2 is second, etc.
                // But the exact mapping can vary, so let's try to match by slot index
                const inputSlotIndex = Math.abs(link.origin_id) - 1;
                console.log("[FriendlyPipe] inputSlotIndex:", inputSlotIndex);
                
                const parentInput = subgraphNode.inputs?.[inputSlotIndex];
                console.log("[FriendlyPipe] parentInput:", parentInput);
                
                if (parentInput && parentInput.link) {
                    const parentGraph = subgraphNode.graph || app.graph;
                    const parentLink = parentGraph.links[parentInput.link];
                    console.log("[FriendlyPipe] parentLink:", parentLink);
                    
                    if (parentLink) {
                        immediateSource = parentGraph.getNodeById(parentLink.origin_id);
                        originSlot = parentLink.origin_slot;
                        console.log("[FriendlyPipe] Found source through parent:", immediateSource);
                    }
                }
            }
        } else {
            immediateSource = graph.getNodeById(link.origin_id);
        }
        
        console.log("[FriendlyPipe] immediateSource:", immediateSource);
        console.log("[FriendlyPipe] immediateSource.type:", immediateSource?.type);
        
        if (!immediateSource) {
            console.log("[FriendlyPipe] No immediate source found");
            return;
        }
        
        // Traverse through reroute/subgraph nodes to find the original FriendlyPipeIn
        const sourceNode = findOriginalSource(immediateSource, originSlot);
        console.log("[FriendlyPipe] sourceNode from traversal:", sourceNode);
        
        if (sourceNode && sourceNode.slotCount !== undefined) {
            console.log("[FriendlyPipe] Found source with slotCount:", sourceNode.slotCount);
            // Make sure source has latest types
            if (sourceNode.updateSlotTypes) {
                sourceNode.updateSlotTypes();
            }
            this.updateFromSource(
                sourceNode.slotCount, 
                sourceNode.slotNames || {},
                sourceNode.slotTypes || {}
            );
        } else if (immediateSource.slotCount !== undefined) {
            console.log("[FriendlyPipe] Using immediate source with slotCount:", immediateSource.slotCount);
            // Fallback to immediate source if traversal failed
            if (immediateSource.updateSlotTypes) {
                immediateSource.updateSlotTypes();
            }
            this.updateFromSource(
                immediateSource.slotCount, 
                immediateSource.slotNames || {},
                immediateSource.slotTypes || {}
            );
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
