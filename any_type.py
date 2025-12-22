class AnyType(str):
    """A special type class that matches any other type in ComfyUI's type system."""
    
    def __ne__(self, other):
        return False
    
    def __eq__(self, other):
        return True
    
    def __hash__(self):
        return hash("*")

# Singleton instance to use as a type
ANY_TYPE = AnyType("*")
