from .any_type import ANY_TYPE

class FriendlyPipeEdit:
    """
    A pipe editing node that adds new slots to an existing FRIENDLY_PIPE.
    Allows extending pipes with additional inputs while preserving existing data.
    """
    
    MAX_SLOTS = 80
    
    @classmethod
    def INPUT_TYPES(cls):
        inputs = {
            "required": {
                "pipe": ("FRIENDLY_PIPE",),
            },
            "optional": {},
            "hidden": {
                "slot_count": ("INT", {"default": 1}),
                "slot_names": ("STRING", {"default": "{}"}),
            }
        }
        
        # Define additional slots as optional with ANY_TYPE
        for i in range(1, cls.MAX_SLOTS + 1):
            inputs["optional"][f"slot_{i}"] = (ANY_TYPE, {"forceInput": True})
        
        return inputs

    RETURN_TYPES = ("FRIENDLY_PIPE",)
    RETURN_NAMES = ("pipe",)
    FUNCTION = "execute"
    CATEGORY = "utils/pipe"
    
    def execute(self, pipe, slot_count=1, slot_names="{}", **kwargs):
        import json
        
        # Parse slot names from JSON string
        try:
            names_dict = json.loads(slot_names)
        except:
            names_dict = {}
        
        # Start with the incoming pipe data
        incoming_slot_count = pipe.get("slot_count", 0)
        incoming_slots = pipe.get("slots", {})
        incoming_names = pipe.get("names", {})
        
        # Create new pipe data combining incoming + new slots
        pipe_data = {
            "slot_count": incoming_slot_count + slot_count,
            "slots": dict(incoming_slots),  # Copy incoming slots
            "names": dict(incoming_names),  # Copy incoming names
        }
        
        # Add new slots with offset indices
        for i in range(1, slot_count + 1):
            slot_key = f"slot_{i}"
            new_index = incoming_slot_count + i
            
            if slot_key in kwargs and kwargs[slot_key] is not None:
                pipe_data["slots"][new_index] = kwargs[slot_key]
            
            # Add names with offset
            if i in names_dict:
                pipe_data["names"][new_index] = names_dict[i]
            elif str(i) in names_dict:
                pipe_data["names"][new_index] = names_dict[str(i)]
        
        return (pipe_data,)
