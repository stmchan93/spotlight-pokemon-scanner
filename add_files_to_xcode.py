#!/usr/bin/env python3
"""
Add Swift files to Xcode project programmatically
"""

import subprocess
import uuid

# Files to add
files_to_add = [
    ("Spotlight/Services/IdentifierLookupService.swift", "Services"),
    ("Spotlight/Services/ScanCacheManager.swift", "Services"),
]

project_file = "Spotlight.xcodeproj/project.pbxproj"

# Generate UUIDs for Xcode
def generate_uuid():
    return str(uuid.uuid4()).upper().replace("-", "")[:24]

# Read project file
with open(project_file, 'r') as f:
    content = f.read()

# Find the Services group
services_group_search = 'path = Services;'
services_group_pos = content.find(services_group_search)

if services_group_pos == -1:
    print("❌ Could not find Services group in project")
    exit(1)

# Go backwards to find the group ID
group_start = content.rfind('/* Services */ = {', 0, services_group_pos)
group_id_start = content.rfind('\t\t', 0, group_start) + 2
group_id_end = content.find(' ', group_id_start)
services_group_id = content[group_id_start:group_id_end]

print(f"✅ Found Services group ID: {services_group_id}")

# Find children array
children_start = content.find('children = (', group_start)
children_end = content.find(');', children_start)

# Add file references
new_content = content

for file_path, group_name in files_to_add:
    file_name = file_path.split('/')[-1]
    file_ref_id = generate_uuid()
    build_file_id = generate_uuid()

    print(f"\n📄 Adding {file_name}...")
    print(f"   File Ref ID: {file_ref_id}")
    print(f"   Build File ID: {build_file_id}")

    # Add to children array
    new_child = f"\t\t\t\t{file_ref_id} /* {file_name} */,\n"
    insert_pos = content.find(');', children_start)
    new_content = new_content[:insert_pos] + new_child + new_content[insert_pos:]

    # Add PBXFileReference
    file_ref = f"""\t\t{file_ref_id} /* {file_name} */ = {{isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = {file_name}; sourceTree = "<group>"; }};\n"""

    # Find PBXFileReference section
    file_ref_section = new_content.find('/* Begin PBXFileReference section */')
    file_ref_insert = new_content.find('\n', file_ref_section) + 1
    new_content = new_content[:file_ref_insert] + file_ref + new_content[file_ref_insert:]

    # Add PBXBuildFile
    build_file = f"""\t\t{build_file_id} /* {file_name} in Sources */ = {{isa = PBXBuildFile; fileRef = {file_ref_id} /* {file_name} */; }};\n"""

    # Find PBXBuildFile section
    build_file_section = new_content.find('/* Begin PBXBuildFile section */')
    build_file_insert = new_content.find('\n', build_file_section) + 1
    new_content = new_content[:build_file_insert] + build_file + new_content[build_file_insert:]

    # Add to Sources build phase
    sources_section = new_content.find('/* Sources */ = {')
    sources_files_start = new_content.find('files = (', sources_section)
    sources_files_insert = new_content.find('\n', sources_files_start) + 1
    sources_entry = f"""\t\t\t\t{build_file_id} /* {file_name} in Sources */,\n"""
    new_content = new_content[:sources_files_insert] + sources_entry + new_content[sources_files_insert:]

# Write updated project file
with open(project_file, 'w') as f:
    f.write(new_content)

print("\n✅ Successfully added files to Xcode project!")
print("\nFiles added:")
for file_path, _ in files_to_add:
    print(f"  - {file_path}")

print("\nNext: Run xcodebuild to verify")
