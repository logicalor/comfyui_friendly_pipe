import { app } from "../../scripts/app.js";

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
            // Store the original onNodeCreated
            const origOnNodeCreated = nodeType.prototype.onNodeCreated;
            
            nodeType.prototype.onNodeCreated = function() {
                if (origOnNodeCreated) {
                    origOnNodeCreated.apply(this, arguments);
                }
                
                const node = this;
                
                // Initialize slot count and names
                this.slotCount = 1;
                this.slotNames = {};
                
                // Add the control buttons widget
                this.addControlButtons();
                
                // Add initial name widget for slot 1
                this.addSlotNameWidget(1);
                
                // Defer the initial visibility update to ensure inputs are ready
                setTimeout(() => {
                    node.updateVisibleSlots();
                }, 0);
            };
            
            nodeType.prototype.addControlButtons = function() {
                const node = this;
                
                // Create a widget that displays the add/subtract buttons
                const widget = this.addWidget("button", "➕ Add Slot", null, () => {
                    if (node.slotCount < 80) {
                        node.slotCount++;
                        node.addSlotNameWidget(node.slotCount);
                        node.updateVisibleSlots();
                        node.setDirtyCanvas(true, true);
                    }
                });
                widget.serialize = false;
                
                const removeWidget = this.addWidget("button", "➖ Remove Slot", null, () => {
                    if (node.slotCount > 1) {
                        node.removeSlotNameWidget(node.slotCount);
                        node.slotCount--;
                        node.updateVisibleSlots();
                        node.setDirtyCanvas(true, true);
                    }
                });
                removeWidget.serialize = false;
            };
            
            nodeType.prototype.addSlotNameWidget = function(slotNum) {
                const node = this;
                const defaultName = `slot_${slotNum}`;
                
                // Create a text input widget for naming this slot
                const nameWidget = this.addWidget("text", `name_${slotNum}`, node.slotNames[slotNum] || defaultName, (value) => {
                    node.slotNames[slotNum] = value;
                    node.updateSlotLabel(slotNum, value);
                    node.updateHiddenSlotNames();
                });
                nameWidget.slotNum = slotNum;
                
                // Initialize the slot name if not set
                if (!node.slotNames[slotNum]) {
                    node.slotNames[slotNum] = defaultName;
                }
                
                // Update the slot label immediately
                node.updateSlotLabel(slotNum, node.slotNames[slotNum]);
            };
            
            nodeType.prototype.removeSlotNameWidget = function(slotNum) {
                // Find and remove the name widget for this slot
                const widgetIndex = this.widgets?.findIndex(w => w.slotNum === slotNum);
                if (widgetIndex !== undefined && widgetIndex >= 0) {
                    this.widgets.splice(widgetIndex, 1);
                }
                // Clean up the slot name
                delete this.slotNames[slotNum];
                this.updateHiddenSlotNames();
            };
            
            nodeType.prototype.updateSlotLabel = function(slotNum, name) {
                // Find the input slot and update its label
                if (this.inputs) {
                    const input = this.inputs.find(inp => inp.name === `slot_${slotNum}`);
                    if (input) {
                        input.label = name || `slot_${slotNum}`;
                    }
                }
            };
            
            nodeType.prototype.updateHiddenSlotNames = function() {
                // Update the hidden slot_names widget with JSON of all names
                const slotNamesWidget = this.widgets?.find(w => w.name === "slot_names");
                if (slotNamesWidget) {
                    slotNamesWidget.value = JSON.stringify(this.slotNames);
                }
            };
            
            nodeType.prototype.updateVisibleSlots = function() {
                // Update the hidden slot_count value
                const slotCountWidget = this.widgets?.find(w => w.name === "slot_count");
                if (slotCountWidget) {
                    slotCountWidget.value = this.slotCount;
                }
                
                // Update hidden slot_names value
                this.updateHiddenSlotNames();
                
                // Show/hide input slots based on current count
                if (this.inputs) {
                    for (let i = 0; i < this.inputs.length; i++) {
                        const input = this.inputs[i];
                        if (!input || !input.name) continue;
                        const match = input.name.match(/^slot_(\d+)$/);
                        if (match) {
                            const slotNum = parseInt(match[1]);
                            input.hidden = slotNum > this.slotCount;
                            
                            // Update label based on stored name
                            if (!input.hidden && this.slotNames[slotNum]) {
                                input.label = this.slotNames[slotNum];
                            }
                        }
                    }
                }
                
                // Show/hide name widgets based on current count
                if (this.widgets) {
                    for (const widget of this.widgets) {
                        if (widget.slotNum !== undefined) {
                            widget.hidden = widget.slotNum > this.slotCount;
                        }
                    }
                }
                
                // Recalculate node size
                this.computeSize();
            };
            
            // Override computeSize to account for hidden slots
            const origComputeSize = nodeType.prototype.computeSize;
            nodeType.prototype.computeSize = function(out) {
                const size = origComputeSize ? origComputeSize.apply(this, arguments) : [200, 100];
                
                // Calculate height based on visible slots + widgets
                const visibleInputs = this.slotCount || 1;
                const widgetHeight = (this.widgets?.length || 0) * 30;
                const inputHeight = visibleInputs * 20;
                const outputHeight = 20; // One output
                const headerHeight = 30;
                const padding = 20;
                
                size[1] = Math.max(size[1], headerHeight + inputHeight + widgetHeight + outputHeight + padding);
                
                return size;
            };
            
            // Custom drawing to only show visible slots
            const origOnDrawForeground = nodeType.prototype.onDrawForeground;
            nodeType.prototype.onDrawForeground = function(ctx) {
                if (origOnDrawForeground) {
                    origOnDrawForeground.apply(this, arguments);
                }
                
                // Hide inputs beyond slotCount by not drawing them
                if (this.inputs) {
                    for (let i = 0; i < this.inputs.length; i++) {
                        const input = this.inputs[i];
                        if (!input || !input.name) continue;
                        const match = input.name.match(/^slot_(\d+)$/);
                        if (match) {
                            const slotNum = parseInt(match[1]);
                            input.hidden = slotNum > this.slotCount;
                        }
                    }
                }
            };
            
            // Handle serialization to save slot count and names
            const origOnSerialize = nodeType.prototype.onSerialize;
            nodeType.prototype.onSerialize = function(o) {
                if (origOnSerialize) {
                    origOnSerialize.apply(this, arguments);
                }
                o.slotCount = this.slotCount;
                o.slotNames = this.slotNames;
            };
            
            // Handle deserialization to restore slot count and names
            const origOnConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function(o) {
                if (origOnConfigure) {
                    origOnConfigure.apply(this, arguments);
                }
                
                // Restore slot names first
                if (o.slotNames) {
                    this.slotNames = o.slotNames;
                }
                
                // Restore slot count and create name widgets
                if (o.slotCount !== undefined) {
                    this.slotCount = o.slotCount;
                    
                    // Add name widgets for all restored slots (skip 1 as it's added in onNodeCreated)
                    for (let i = 2; i <= this.slotCount; i++) {
                        this.addSlotNameWidget(i);
                    }
                    
                    // Update widget values with restored names
                    if (this.widgets) {
                        for (const widget of this.widgets) {
                            if (widget.slotNum !== undefined && this.slotNames[widget.slotNum]) {
                                widget.value = this.slotNames[widget.slotNum];
                            }
                        }
                    }
                    
                    // Defer update to ensure inputs are ready
                    const node = this;
                    setTimeout(() => {
                        node.updateVisibleSlots();
                    }, 0);
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
        
        // Initialize slot count and names
        this.slotCount = 1;
        this.slotNames = {};
        
        // Defer the initial visibility update to ensure outputs are ready
        setTimeout(() => {
            node.updateVisibleOutputs();
        }, 0);
    };
    
    nodeType.prototype.updateVisibleOutputs = function() {
        // Show/hide output slots based on current count
        if (this.outputs) {
            for (let i = 0; i < this.outputs.length; i++) {
                const output = this.outputs[i];
                if (!output || !output.name) continue;
                const match = output.name.match(/^slot_(\d+)$/);
                if (match) {
                    const slotNum = parseInt(match[1]);
                    output.hidden = slotNum > this.slotCount;
                    
                    // Update label based on stored name
                    if (!output.hidden && this.slotNames[slotNum]) {
                        output.label = this.slotNames[slotNum];
                    } else if (!output.hidden) {
                        output.label = `slot_${slotNum}`;
                    }
                }
            }
        }
        
        // Recalculate node size
        this.computeSize();
        this.setDirtyCanvas(true, true);
    };
    
    nodeType.prototype.updateOutputLabels = function(names) {
        if (this.outputs) {
            for (let i = 0; i < this.outputs.length; i++) {
                const output = this.outputs[i];
                if (!output || !output.name) continue;
                const match = output.name.match(/^slot_(\d+)$/);
                if (match) {
                    const slotNum = parseInt(match[1]);
                    if (names[slotNum]) {
                        output.label = names[slotNum];
                    } else {
                        output.label = `slot_${slotNum}`;
                    }
                }
            }
        }
    };
    
    // Handle connection changes to update from connected FriendlyPipeIn
    const origOnConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function(type, index, connected, linkInfo) {
        if (origOnConnectionsChange) {
            origOnConnectionsChange.apply(this, arguments);
        }
        
        // When input connection changes, try to get info from connected node
        if (type === 1) { // Input connection
            this.updateFromConnectedPipe();
        }
    };
    
    nodeType.prototype.updateFromConnectedPipe = function() {
        // Find the connected FriendlyPipeIn node
        if (!this.inputs || !this.inputs[0] || !this.inputs[0].link) {
            // No connection, reset to default
            this.slotCount = 1;
            this.slotNames = {};
            this.updateVisibleOutputs();
            return;
        }
        
        const linkId = this.inputs[0].link;
        const link = app.graph.links[linkId];
        if (!link) return;
        
        const sourceNode = app.graph.getNodeById(link.origin_id);
        if (!sourceNode) return;
        
        // Check if it's a FriendlyPipeIn or another FriendlyPipeOut (for chaining)
        if (sourceNode.type === "FriendlyPipeIn" || sourceNode.type === "FriendlyPipeOut") {
            this.slotCount = sourceNode.slotCount || 1;
            this.slotNames = sourceNode.slotNames || {};
            this.updateOutputLabels(this.slotNames);
            this.updateVisibleOutputs();
        }
    };
    
    // Override computeSize to account for hidden slots
    const origComputeSize = nodeType.prototype.computeSize;
    nodeType.prototype.computeSize = function(out) {
        const size = origComputeSize ? origComputeSize.apply(this, arguments) : [200, 100];
        
        // Calculate height based on visible outputs
        const visibleOutputs = this.slotCount || 1;
        const inputHeight = 20; // One input (pipe)
        const outputHeight = visibleOutputs * 20;
        const headerHeight = 30;
        const padding = 20;
        
        size[1] = Math.max(size[1], headerHeight + inputHeight + outputHeight + padding);
        
        return size;
    };
    
    // Custom drawing to only show visible outputs
    const origOnDrawForeground = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function(ctx) {
        if (origOnDrawForeground) {
            origOnDrawForeground.apply(this, arguments);
        }
        
        // Hide outputs beyond slotCount
        if (this.outputs) {
            for (let i = 0; i < this.outputs.length; i++) {
                const output = this.outputs[i];
                if (!output || !output.name) continue;
                const match = output.name.match(/^slot_(\d+)$/);
                if (match) {
                    const slotNum = parseInt(match[1]);
                    output.hidden = slotNum > this.slotCount;
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
    };
    
    // Handle deserialization
    const origOnConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function(o) {
        if (origOnConfigure) {
            origOnConfigure.apply(this, arguments);
        }
        
        if (o.slotNames) {
            this.slotNames = o.slotNames;
        }
        if (o.slotCount !== undefined) {
            this.slotCount = o.slotCount;
        }
        
        this.updateOutputLabels(this.slotNames);
        
        // Defer update to ensure outputs are ready
        const node = this;
        setTimeout(() => {
            node.updateVisibleOutputs();
        }, 0);
    };
}
