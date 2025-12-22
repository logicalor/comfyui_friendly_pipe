from .any_type import ANY_TYPE

class FriendlyPipeOut:
    """
    A pipe output node that unpacks a FRIENDLY_PIPE into individual outputs.
    Output slots dynamically reflect the connected FriendlyPipeIn's configuration.
    """
    
    MAX_SLOTS = 80
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "pipe": ("FRIENDLY_PIPE",),
            },
            "hidden": {
                "slot_count": ("INT", {"default": 1}),
                "slot_names": ("STRING", {"default": "{}"}),
            }
        }

    # Define all possible output slots with ANY_TYPE that matches all types
    RETURN_TYPES = tuple([ANY_TYPE] * MAX_SLOTS)
    RETURN_NAMES = tuple([f"slot_{i}" for i in range(1, MAX_SLOTS + 1)])
    FUNCTION = "execute"
    CATEGORY = "utils/pipe"
    OUTPUT_NODE = False
    
    def execute(self, pipe, slot_count=1, slot_names="{}"):
        # Extract values from the pipe data
        pipe_slots = pipe.get("slots", {})
        pipe_slot_count = pipe.get("slot_count", 1)
        
        # Build output tuple - return None for empty/missing slots
        outputs = []
        for i in range(1, self.MAX_SLOTS + 1):
            if i in pipe_slots:
                outputs.append(pipe_slots[i])
            else:
                outputs.append(None)
        
        return tuple(outputs)
