# Copilot Instructions for ComfyUI Friendly Pipe

## Project Overview

This is a **ComfyUI custom node pack** called "Friendly Pipe" that provides flexible pipe nodes for bundling and unbundling multiple connections of any type. It allows ComfyUI workflow creators to organize complex workflows by bundling related connections through a single pipe.

- **Repository**: `logicalor/comfyui_friendly_pipe`
- **Version**: 1.2.5
- **License**: MIT

## Architecture

### Node Types

The pack provides three custom nodes:

1. **FriendlyPipeIn** - Bundles up to 80 inputs into a single `FRIENDLY_PIPE` output
2. **FriendlyPipeOut** - Unpacks a `FRIENDLY_PIPE` back into individual outputs  
3. **FriendlyPipeEdit** - Extends an existing pipe by adding new slots while preserving original slots

### File Structure

```
comfyui_friendly_pipe/
├── __init__.py            # Node registration (NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS)
├── friendly_pipe_in.py    # FriendlyPipeIn Python backend
├── friendly_pipe_out.py   # FriendlyPipeOut Python backend
├── friendly_pipe_edit.py  # FriendlyPipeEdit Python backend
├── any_type.py            # AnyType class for universal type compatibility
├── pyproject.toml         # ComfyUI Manager metadata
├── README.md              # Documentation
└── js/
    └── friendly_pipe.js   # Frontend JavaScript (~1200 lines) for dynamic UI
```

## Technical Details

### AnyType System (`any_type.py`)

The `AnyType` class is crucial for type compatibility:

```python
class AnyType(str):
    """A special type class that matches any other type in ComfyUI's type system."""
    def __ne__(self, other): return False
    def __eq__(self, other): return True
    def __hash__(self): return hash("*")

ANY_TYPE = AnyType("*")
```

- Inherits from `str` with value `"*"`
- Overrides equality operators to match any type
- Enables inputs to accept any ComfyUI data type
- Used by all three node types for their slot definitions

### Pipe Data Structure

The `FRIENDLY_PIPE` type carries a dictionary:

```python
{
    "slot_count": int,           # Total number of slots
    "slots": {int: Any},         # Slot index -> data mapping
    "names": {int: str}          # Slot index -> label mapping
}
```

### Python Backend Patterns

Each node class follows ComfyUI conventions:

- `INPUT_TYPES()` - Class method returning input definitions
- `RETURN_TYPES` - Tuple of output types
- `RETURN_NAMES` - Tuple of output names
- `FUNCTION` - Name of the execution method (always `"execute"`)
- `CATEGORY` - Node category in ComfyUI menu (`"utils/pipe"`)
- `MAX_SLOTS = 80` - Maximum slots per node

**Hidden inputs** are used for UI state:
- `slot_count` (INT) - Number of active slots
- `slot_names` (STRING) - JSON-encoded slot labels

### JavaScript Frontend (`js/friendly_pipe.js`)

The frontend is registered as a ComfyUI extension:

```javascript
app.registerExtension({
    name: "Comfy.FriendlyPipe",
    async beforeRegisterNodeDef(nodeType, nodeData, app) { ... }
});
```

Key concepts:

1. **Dynamic Slots**: Add/remove input slots via button widgets
2. **Label Widgets**: Text widgets for naming each slot
3. **Auto-Sync**: FriendlyPipeOut automatically syncs with connected source
4. **Subgraph Support**: Handles traversal through reroute nodes and subgraphs

Important helper functions:
- `findOriginalSource()` - Traverses backwards through reroutes/subgraphs to find source
- `notifyDownstreamNodes()` - Propagates changes to connected output nodes
- `findSourceThroughParent()` - Handles subgraph boundary traversal
- `isPassThroughNode()` - Detects reroute/primitive nodes

### Serialization

Both Python and JavaScript handle serialization:
- `onSerialize` / `onConfigure` in JS for graph save/load
- Hidden widgets pass state to Python during execution

## Development Guidelines

### When Adding New Features

1. **Python Changes**: Update the relevant `friendly_pipe_*.py` file
2. **UI Changes**: Modify `js/friendly_pipe.js` 
3. **Type Changes**: Update `any_type.py` if needed
4. **Node Registration**: Update `__init__.py` if adding new nodes

### Coding Conventions

- Use `forceInput: True` for slots that should only accept connections
- Normalize slot keys to integers when reading from pipe data (handle both int and string keys)
- Use `"*"` as the universal type string in LiteGraph
- Always notify downstream nodes after changes via `notifyConnectedOutputs()`

### Testing Considerations

- Test with reroute nodes between pipe nodes
- Test with subgraphs containing pipe nodes
- Test serialization (save/reload workflow)
- Test chaining multiple FriendlyPipeEdit nodes
- Verify type passthrough works with typed inputs

### Common Issues

1. **Slot Sync**: If FriendlyPipeOut doesn't update, check `syncWithSource()` traversal
2. **Subgraph Issues**: Check `findSourceThroughParent()` and `_subgraph_node` handling
3. **Type Mismatch**: Ensure `ANY_TYPE` is used consistently
4. **Widget Order**: Label widgets must be inserted before add/remove buttons

## ComfyUI Integration

### Required Exports (`__init__.py`)

```python
NODE_CLASS_MAPPINGS = { ... }      # Maps node type names to classes
NODE_DISPLAY_NAME_MAPPINGS = { ... }  # Maps node type names to display names
WEB_DIRECTORY = "./js"              # Frontend JavaScript location
```

### ComfyUI Manager (`pyproject.toml`)

```toml
[tool.comfy]
PublisherId = "logicalor"
DisplayName = "Friendly Pipe"
```

## Key Implementation Notes

1. **Slot Count**: The `MAX_SLOTS` constant (80) is defined in each node class
2. **Type Preservation**: Connected types are tracked in `slotTypes` dict and passed through the pipe
3. **Input Labels**: Slot labels are stored in `slotNames` dict and reflected on input/output ports
4. **FriendlyPipeEdit**: Maintains both `incomingSlot*` (from upstream pipe) and local `slot*` properties
5. **Subgraph Traversal**: Uses negative `origin_id` detection and `_subgraph_node` references
