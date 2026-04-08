#!/usr/bin/env ruby
# Add Swift files to Xcode project using xcodeproj gem

require 'xcodeproj'

project_path = 'Spotlight.xcodeproj'
project = Xcodeproj::Project.open(project_path)

# Get the main target
target = project.targets.first

# Find the Services group
services_group = project.main_group['Spotlight']['Services']

if services_group.nil?
  puts "❌ Could not find Services group"
  exit 1
end

puts "✅ Found Services group"

# Files to add
files = [
  'Spotlight/Services/ScanCacheManager.swift'
]

files.each do |file_path|
  file_name = File.basename(file_path)

  # Check if file already exists in project
  existing = services_group.files.find { |f| f.path == file_name }

  if existing
    puts "⚠️  #{file_name} already in project, skipping"
    next
  end

  # Add file reference to group
  file_ref = services_group.new_reference(file_name)

  # Add file to target's sources build phase
  target.add_file_references([file_ref])

  puts "✅ Added #{file_name}"
end

# Save project
project.save

puts "\n✅ Successfully updated Xcode project!"
puts "Files are now part of the build."
