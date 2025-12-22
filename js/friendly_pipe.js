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
        // Find all nodes connected to our output and notify them
        if (!this.outputs || !this.outputs[0] || !this.outputs[0].links) return;
        
        for (const linkId of this.outputs[0].links) {
            const link = app.graph.links[linkId];
            if (!link) continue;
            
            const targetNode = app.graph.getNodeById(link.target_id);
            if (targetNode && targetNode.syncWithSource) {
                targetNode.syncWithSource();
            }
        }
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
        if (!this.inputs || !this.inputs[0] || !this.inputs[0].link) {
            // No connection, reset to default
            this.updateFromSource(1, {}, {});
            return;
        }
        
        const linkId = this.inputs[0].link;
        const link = app.graph.links[linkId];
        if (!link) return;
        
        const sourceNode = app.graph.getNodeById(link.origin_id);
        if (!sourceNode) return;
        
        if (sourceNode.slotCount !== undefined) {
            // Make sure source has latest types
            if (sourceNode.updateSlotTypes) {
                sourceNode.updateSlotTypes();
            }
            this.updateFromSource(
                sourceNode.slotCount, 
                sourceNode.slotNames || {},
                sourceNode.slotTypes || {}
            );
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
